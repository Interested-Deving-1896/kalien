import { Hono } from "hono";
import type { WorkerEnv } from "../env";
import { LEADERBOARD_CACHE_CONTROL, LEADERBOARD_PRIVATE_CACHE_CONTROL } from "../cache-control";
import {
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_OFFSET,
  parseLeaderboardWindow,
} from "../leaderboard";
import {
  getLeaderboardPage,
  getLeaderboardPlayer,
  getLeaderboardIngestionState,
  upsertLeaderboardProfile,
  createLeaderboardProfileAuthChallenge,
  getLeaderboardProfileAuthChallenge,
  getLeaderboardProfileCredential,
  markLeaderboardProfileAuthChallengeUsed,
  purgeExpiredLeaderboardProfileAuthChallenges,
  updateLeaderboardProfileCredentialCounter,
  upsertLeaderboardProfileCredential,
} from "../leaderboard-store";
import {
  assertCredentialBelongsToClaimantContract,
  encodeRawP256PublicKeyBase64UrlToCose,
  fetchCredentialPublicKeyFromChain,
  LeaderboardCredentialBindingError,
} from "../leaderboard-profile-auth";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { safeErrorMessage } from "../utils";
import { validateClaimantStrKey } from "../../shared/stellar/strkey";

const MAX_USERNAME_LENGTH = 32;
const MAX_LINK_URL_LENGTH = 240;
const USERNAME_PATTERN = /^[a-zA-Z0-9 _.@#-]+$/u;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const READ_RATE_LIMIT = 60;
const WRITE_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const rateLimitCounters = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PRUNE_THRESHOLD = 1_000;

function checkRateLimit(ip: string, limit: number): boolean {
  const now = Date.now();
  const key = `${ip}:${limit}`;
  const entry = rateLimitCounters.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitCounters.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    pruneExpiredRateLimits(now);
    return true;
  }

  entry.count += 1;
  return entry.count <= limit;
}

function pruneExpiredRateLimits(now: number): void {
  if (rateLimitCounters.size <= RATE_LIMIT_PRUNE_THRESHOLD) {
    return;
  }
  for (const [key, entry] of rateLimitCounters) {
    if (now >= entry.resetAt) {
      rateLimitCounters.delete(key);
    }
  }
}

function clientIp(c: { req: { raw: Request } }): string {
  return c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
}

function jsonError(
  c: { json: (body: unknown, status?: number) => Response },
  status: number,
  error: string,
): Response {
  return c.json({ success: false, error }, status);
}

function validateLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function sanitizeUsername(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return null;
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function safeLinkUrl(url: string | null | undefined): string | null {
  if (!url || url.trim().length === 0) {
    return null;
  }
  const trimmed = url.trim();
  if (trimmed.length > MAX_LINK_URL_LENGTH) {
    return null;
  }
  if (!validateLinkUrl(trimmed)) {
    return null;
  }
  return trimmed;
}

export function createLeaderboardPublicRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  // GET /api/leaderboard
  router.get("/", async (c) => {
    if (!checkRateLimit(clientIp(c), READ_RATE_LIMIT)) {
      c.header("Retry-After", "60");
      return jsonError(c, 429, "rate limit exceeded");
    }

    try {
      const windowRaw = c.req.query("window");
      const window = parseLeaderboardWindow(windowRaw);
      if (!window) {
        return jsonError(c, 400, `invalid window: ${windowRaw}`);
      }

      const limitRaw = c.req.query("limit");
      const limit = limitRaw
        ? Math.min(
            Math.max(Number.parseInt(limitRaw, 10) || DEFAULT_LEADERBOARD_LIMIT, 1),
            MAX_LEADERBOARD_LIMIT,
          )
        : DEFAULT_LEADERBOARD_LIMIT;

      const offsetRaw = c.req.query("offset");
      const offset = offsetRaw
        ? Math.min(Math.max(Number.parseInt(offsetRaw, 10) || 0, 0), MAX_LEADERBOARD_OFFSET)
        : 0;

      const address = c.req.query("address")?.trim() || null;

      const page = await getLeaderboardPage(c.env, {
        window,
        limit,
        offset,
        claimantAddress: address,
      });

      const ingestion = await getLeaderboardIngestionState(c.env);

      const payload = {
        success: true,
        source: "d1",
        provider: ingestion.provider,
        provider_mode: ingestion.provider,
        source_mode: ingestion.sourceMode,
        window: page.window,
        generated_at: page.generatedAt,
        window_range: {
          start_at: page.windowRange.startAt,
          end_at: page.windowRange.endAt,
        },
        pagination: {
          limit: page.limit,
          offset: page.offset,
          total: page.totalPlayers,
          next_offset: page.nextOffset,
        },
        entries: page.entries,
        me: page.me,
        ingestion: {
          last_synced_at: ingestion.lastSyncedAt,
          highest_ledger: ingestion.highestLedger,
          total_events: ingestion.totalEvents,
        },
      };

      const body = JSON.stringify(payload);

      // Use private cache when caller asks for a specific address (personalised response).
      c.header(
        "Cache-Control",
        address ? LEADERBOARD_PRIVATE_CACHE_CONTROL : LEADERBOARD_CACHE_CONTROL,
      );

      // ETag for conditional revalidation
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const hashHex = Array.from(new Uint8Array(digest.slice(0, 8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const etag = `"lb-${hashHex}"`;
      c.header("ETag", etag);

      const ifNoneMatch = c.req.header("if-none-match");
      if (ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            "Cache-Control": address
              ? LEADERBOARD_PRIVATE_CACHE_CONTROL
              : LEADERBOARD_CACHE_CONTROL,
            ETag: etag,
          },
        });
      }

      return c.json(payload);
    } catch (error) {
      console.error(`[leaderboard] GET / error: ${safeErrorMessage(error)}`);
      return jsonError(c, 503, "leaderboard temporarily unavailable");
    }
  });

  // GET /api/leaderboard/player/:address
  router.get("/player/:address", async (c) => {
    if (!checkRateLimit(clientIp(c), READ_RATE_LIMIT)) {
      c.header("Retry-After", "60");
      return jsonError(c, 429, "rate limit exceeded");
    }

    try {
      const address = c.req.param("address");
      if (!address || address.trim().length === 0) {
        return jsonError(c, 400, "missing player address");
      }

      try {
        validateClaimantStrKey(address);
      } catch {
        return jsonError(c, 400, "invalid player address");
      }

      const runsLimitRaw = c.req.query("runs_limit");
      const runsLimit = runsLimitRaw ? Number.parseInt(runsLimitRaw, 10) || 25 : 25;
      const runsOffsetRaw = c.req.query("runs_offset");
      const runsOffset = runsOffsetRaw ? Number.parseInt(runsOffsetRaw, 10) || 0 : 0;

      const player = await getLeaderboardPlayer(c.env, address, {
        limit: runsLimit,
        offset: runsOffset,
      });

      c.header("Cache-Control", LEADERBOARD_PRIVATE_CACHE_CONTROL);
      return c.json({
        success: true,
        player: {
          claimant_address: address,
          profile: player.profile,
          stats: {
            total_runs: player.stats.totalRuns,
            best_score: player.stats.bestScore,
            total_minted: player.stats.totalMinted,
            last_played_at: player.stats.lastPlayedAt,
          },
          ranks: {
            ten_min: player.ranks.tenMin,
            day: player.ranks.day,
            all: player.ranks.all,
          },
          recent_runs: player.recentRuns,
          runs_pagination: {
            limit: player.runsPagination.limit,
            offset: player.runsPagination.offset,
            total: player.runsPagination.total,
            next_offset: player.runsPagination.nextOffset,
          },
        },
      });
    } catch (error) {
      console.error(`[leaderboard] GET /player/:address error: ${safeErrorMessage(error)}`);
      return jsonError(c, 503, "leaderboard temporarily unavailable");
    }
  });

  // POST /api/leaderboard/player/:address/profile/auth/options
  router.post("/player/:address/profile/auth/options", async (c) => {
    if (!checkRateLimit(clientIp(c), WRITE_RATE_LIMIT)) {
      c.header("Retry-After", "60");
      return jsonError(c, 429, "rate limit exceeded");
    }

    try {
      const address = c.req.param("address");
      if (!address || address.trim().length === 0) {
        return jsonError(c, 400, "missing player address");
      }

      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return jsonError(c, 400, "invalid JSON body");
      }

      const credentialId = body.credential_id;
      if (typeof credentialId !== "string" || credentialId.trim().length === 0) {
        return jsonError(c, 400, "missing credential_id");
      }

      // Verify credential belongs to claimant address via indexer
      try {
        await assertCredentialBelongsToClaimantContract({
          claimantAddress: address,
          credentialIdBase64Url: credentialId,
          indexerBaseUrl: c.env.SMART_ACCOUNT_INDEXER_URL,
        });
      } catch (error) {
        if (error instanceof LeaderboardCredentialBindingError) {
          return jsonError(c, error.statusCode, error.message);
        }
        throw error;
      }

      // Check D1 cache for public key; if not found, fetch from chain
      let credential = await getLeaderboardProfileCredential(c.env, credentialId);
      if (!credential) {
        const rpcUrl = c.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
        const networkPassphrase =
          c.env.CLAIM_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

        let rawPublicKeyBase64Url: string;
        try {
          rawPublicKeyBase64Url = await fetchCredentialPublicKeyFromChain({
            contractAddress: address,
            credentialIdBase64Url: credentialId,
            rpcUrl,
            networkPassphrase,
          });
        } catch (error) {
          if (error instanceof LeaderboardCredentialBindingError) {
            return jsonError(c, error.statusCode, error.message);
          }
          console.error(`[leaderboard] fetch chain pubkey error: ${safeErrorMessage(error)}`);
          return jsonError(c, 503, "failed to fetch credential public key from chain");
        }

        credential = await upsertLeaderboardProfileCredential(c.env, {
          claimantAddress: address,
          credentialId,
          publicKey: rawPublicKeyBase64Url,
        });
      }

      // Derive origin and RP ID from request URL
      const requestUrl = new URL(c.req.url);
      const rpId = requestUrl.hostname;
      const expectedOrigin = requestUrl.origin;

      // Generate WebAuthn authentication options
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials: [
          {
            id: credentialId,
            transports: (credential.transports ?? undefined) as
              | ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[]
              | undefined,
          },
        ],
        userVerification: "required",
        timeout: 300_000,
      });

      // Purge expired challenges, then store new one
      await purgeExpiredLeaderboardProfileAuthChallenges(c.env);

      const challengeId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
      await createLeaderboardProfileAuthChallenge(c.env, {
        challengeId,
        claimantAddress: address,
        credentialId,
        challenge: options.challenge,
        expectedOrigin,
        expectedRpId: rpId,
        expiresAt,
      });

      // This response includes a one-time challenge and should never be cached.
      c.header("Cache-Control", "no-store");
      return c.json({
        success: true,
        challenge_id: challengeId,
        options,
      });
    } catch (error) {
      console.error(`[leaderboard] POST auth/options error: ${safeErrorMessage(error)}`);
      return jsonError(c, 503, "leaderboard temporarily unavailable");
    }
  });

  // PUT /api/leaderboard/player/:address/profile
  router.put("/player/:address/profile", async (c) => {
    if (!checkRateLimit(clientIp(c), WRITE_RATE_LIMIT)) {
      c.header("Retry-After", "60");
      return jsonError(c, 429, "rate limit exceeded");
    }

    try {
      const address = c.req.param("address");
      if (!address || address.trim().length === 0) {
        return jsonError(c, 400, "missing player address");
      }

      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return jsonError(c, 400, "invalid JSON body");
      }

      // Validate auth object
      const auth = body.auth;
      if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
        return jsonError(c, 400, "missing auth object");
      }
      const authObj = auth as Record<string, unknown>;
      const challengeId = authObj.challenge_id;
      if (typeof challengeId !== "string" || challengeId.trim().length === 0) {
        return jsonError(c, 400, "missing auth.challenge_id");
      }
      const authResponse = authObj.response;
      if (!authResponse || typeof authResponse !== "object" || Array.isArray(authResponse)) {
        return jsonError(c, 400, "missing auth.response");
      }

      // Validate username
      const rawUsername = body.username;
      let username: string | null = null;
      if (rawUsername !== null && rawUsername !== undefined) {
        if (typeof rawUsername !== "string") {
          return jsonError(c, 400, "username must be a string");
        }
        if (rawUsername.trim().length > 0) {
          username = sanitizeUsername(rawUsername);
          if (username === null) {
            return jsonError(
              c,
              400,
              `username must be 1-${MAX_USERNAME_LENGTH} chars, alphanumeric and basic punctuation only`,
            );
          }
        }
      }

      // Validate link_url
      const rawLinkUrl = body.link_url;
      let linkUrl: string | null = null;
      if (rawLinkUrl !== null && rawLinkUrl !== undefined) {
        if (typeof rawLinkUrl !== "string") {
          return jsonError(c, 400, "link_url must be a string");
        }
        if (rawLinkUrl.trim().length > 0) {
          linkUrl = safeLinkUrl(rawLinkUrl);
          if (linkUrl === null) {
            return jsonError(
              c,
              400,
              `link_url must be a valid http or https URL (max ${MAX_LINK_URL_LENGTH} chars)`,
            );
          }
        }
      }

      // Retrieve and validate challenge
      const challenge = await getLeaderboardProfileAuthChallenge(c.env, challengeId);
      if (!challenge) {
        return jsonError(c, 401, "invalid or expired challenge");
      }
      if (challenge.claimantAddress !== address) {
        return jsonError(c, 401, "challenge does not match claimant address");
      }
      if (challenge.usedAt !== null) {
        return jsonError(c, 401, "challenge already used");
      }
      if (new Date(challenge.expiresAt).getTime() < Date.now()) {
        return jsonError(c, 401, "challenge expired");
      }

      // Atomically claim the challenge BEFORE verification to prevent race conditions.
      // The SQL uses WHERE used_at IS NULL, so only one concurrent request can succeed.
      const claimed = await markLeaderboardProfileAuthChallengeUsed(c.env, challengeId);
      if (!claimed) {
        return jsonError(c, 401, "challenge already used");
      }

      // Retrieve cached credential (public key)
      const credential = await getLeaderboardProfileCredential(c.env, challenge.credentialId);
      if (!credential) {
        return jsonError(c, 401, "credential not found");
      }

      // Verify WebAuthn response
      const cosePublicKey = encodeRawP256PublicKeyBase64UrlToCose(credential.publicKey);
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: authResponse as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.expectedOrigin,
          expectedRPID: challenge.expectedRpId,
          credential: {
            id: credential.credentialId,
            publicKey: cosePublicKey as Uint8Array<ArrayBuffer>,
            counter: credential.counter,
            transports: (credential.transports ?? undefined) as
              | ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[]
              | undefined,
          },
          requireUserVerification: true,
        });
      } catch (error) {
        console.error(`[leaderboard] webauthn verify error: ${safeErrorMessage(error)}`);
        return jsonError(c, 401, "WebAuthn verification failed");
      }

      if (!verification.verified) {
        return jsonError(c, 401, "WebAuthn verification failed");
      }

      // Update counter (challenge already marked used above)
      await updateLeaderboardProfileCredentialCounter(
        c.env,
        credential.credentialId,
        verification.authenticationInfo.newCounter,
      );

      // Upsert profile
      const profile = await upsertLeaderboardProfile(c.env, address, {
        username,
        linkUrl,
      });

      return c.json({
        success: true,
        profile,
      });
    } catch (error) {
      console.error(`[leaderboard] PUT profile error: ${safeErrorMessage(error)}`);
      return jsonError(c, 503, "leaderboard temporarily unavailable");
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Dev endpoints — gated by DEV_API_KEY (must be set and >= 16 chars).
// Requests must include "Authorization: Bearer <key>".
// If key is missing/weak, endpoints return 404 to appear absent.
// ---------------------------------------------------------------------------
export function createLeaderboardDevRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  router.use("/*", async (c, next) => {
    const key = c.env.DEV_API_KEY?.trim();
    if (!key || key.length < 16) {
      return jsonError(c, 404, `unknown api route: ${c.req.path}`);
    }

    const authHeader = c.req.header("authorization") ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== key) {
      return jsonError(c, 401, "valid authorization required for dev endpoints");
    }

    await next();
  });

  // DEV-ONLY: Trigger leaderboard sync (same as cron handler)
  // Pass ?reset_cursor=1 to clear stale RPC cursor.
  // Pass ?from_ledger=N to override the start ledger (skips gaps).
  router.post("/sync", async (c) => {
    const { runLeaderboardSync, runScheduledLeaderboardSync } = await import("../leaderboard-sync");
    const { setLeaderboardIngestionState, getLeaderboardIngestionState: getIngestionState } =
      await import("../leaderboard-store");
    try {
      if (c.req.query("reset_cursor") === "1") {
        const state = await getIngestionState(c.env);
        await setLeaderboardIngestionState(c.env, { ...state, cursor: null });
      }
      const fromLedgerRaw = c.req.query("from_ledger");
      if (fromLedgerRaw) {
        const fromLedger = Number.parseInt(fromLedgerRaw, 10);
        if (!Number.isFinite(fromLedger) || fromLedger < 2) {
          return jsonError(c, 400, "invalid from_ledger");
        }
        // Clear persisted cursor so from_ledger takes effect
        const state = await getLeaderboardIngestionState(c.env);
        await setLeaderboardIngestionState(c.env, { ...state, cursor: null });
        const result = await runLeaderboardSync(c.env, {
          mode: "forward",
          fromLedger,
          cursor: null,
          limit: 200,
        });
        return c.json({
          success: true,
          forward: result,
          catchup: null,
          warning: null,
        });
      }
      const result = await runScheduledLeaderboardSync(c.env);
      return c.json({ success: true, ...result });
    } catch (error) {
      console.error(`[leaderboard-sync] dev/sync failed: ${safeErrorMessage(error)}`);
      return jsonError(c, 500, safeErrorMessage(error));
    }
  });

  // DEV-ONLY: Reset all leaderboard data
  router.post("/reset", async (c) => {
    const db = c.env.LEADERBOARD_DB;
    await db.batch([
      db.prepare("DELETE FROM leaderboard_events"),
      db.prepare("DELETE FROM leaderboard_profiles"),
      db.prepare("DELETE FROM leaderboard_profile_credentials"),
      db.prepare("DELETE FROM leaderboard_profile_auth_challenges"),
      db.prepare("DELETE FROM leaderboard_ingestion_state"),
      db.prepare("DELETE FROM proof_tape_index"),
    ]);
    return c.json({ success: true, message: "all leaderboard data cleared" });
  });

  // DEV-ONLY: Seed test data into the leaderboard
  router.post("/seed", async (c) => {
    let body: { events: unknown[]; profiles?: unknown[] };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return jsonError(c, 400, "invalid JSON body");
    }

    if (!Array.isArray(body.events) || body.events.length === 0) {
      return jsonError(c, 400, "events must be a non-empty array");
    }

    const { upsertLeaderboardEvents, upsertLeaderboardProfiles, setLeaderboardIngestionState } =
      await import("../leaderboard-store");

    const events = (body.events as Record<string, unknown>[]).map((e) => ({
      eventId: String(e.eventId ?? crypto.randomUUID()),
      claimantAddress: String(e.claimantAddress),
      seed: Number(e.seed) >>> 0,
      frameCount: e.frameCount != null ? Number(e.frameCount) : null,
      finalScore: Number(e.finalScore),
      previousBest: Number(e.previousBest ?? 0),
      newBest: Number(e.newBest ?? e.finalScore),
      mintedDelta: Number(e.mintedDelta ?? e.finalScore),
      txHash: e.txHash != null ? String(e.txHash) : null,
      eventIndex: e.eventIndex != null ? Number(e.eventIndex) : null,
      ledger: e.ledger != null ? Number(e.ledger) : null,
      closedAt: String(e.closedAt ?? new Date().toISOString()),
      source: (e.source === "rpc" ? "rpc" : "galexie") as "galexie" | "rpc",
      ingestedAt: String(e.ingestedAt ?? new Date().toISOString()),
    }));

    const result = await upsertLeaderboardEvents(c.env, events);

    // Upsert profiles if provided
    let profileCount = 0;
    if (Array.isArray(body.profiles) && body.profiles.length > 0) {
      const profiles = (body.profiles as Record<string, unknown>[]).map((p) => ({
        claimantAddress: String(p.claimantAddress),
        username: p.username != null ? String(p.username) : null,
        linkUrl: p.linkUrl != null ? String(p.linkUrl) : null,
        updatedAt: String(p.updatedAt ?? new Date().toISOString()),
      }));
      profileCount = await upsertLeaderboardProfiles(c.env, profiles);
    }

    // Update ingestion state so the UI shows sync info
    await setLeaderboardIngestionState(c.env, {
      provider: "rpc",
      sourceMode: "rpc",
      cursor: null,
      highestLedger: Math.max(...events.map((e) => e.ledger ?? 0)),
      lastSyncedAt: new Date().toISOString(),
      lastBackfillAt: null,
      totalEvents: events.length,
      lastError: null,
    });

    return c.json({
      success: true,
      inserted: result.inserted,
      updated: result.updated,
      profiles: profileCount,
    });
  });

  return router;
}
