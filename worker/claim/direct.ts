import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import {
  ChannelsClient,
  PluginExecutionError,
  PluginTransportError,
} from "@openzeppelin/relayer-plugin-channels/dist/client";
import { Client as ScoreContractClient } from "asteroids-score";
import {
  DEFAULT_BINDINGS_RPC_URL,
  DEFAULT_RELAYER_REQUEST_TIMEOUT_MS,
  OPENZEPPELIN_CHANNELS_HOSTNAME,
  TESTNET_NETWORK_PASSPHRASE,
} from "../constants";
import type { WorkerEnv } from "../env";
import { parseInteger, safeErrorMessage } from "../utils";
import type { RelayClaimRequest, RelaySubmitResult } from "./types";

interface ChannelsConfig {
  baseUrl: string;
  apiKey: string;
  pluginId: string | null;
  timeoutMs: number;
}

interface DirectClaimConfig {
  scoreContractId: string;
  channels: ChannelsConfig;
}

const SEED_INTERVAL_SECONDS = 600;

function nonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveChannelsConfig(env: WorkerEnv): ChannelsConfig | null {
  const relayUrlRaw = nonEmpty(env.RELAYER_URL);
  const apiKey = nonEmpty(env.RELAYER_API_KEY);
  if (!relayUrlRaw || !apiKey) {
    return null;
  }

  let relayUrl: URL;
  try {
    relayUrl = new URL(relayUrlRaw);
  } catch {
    return null;
  }

  const pluginId = nonEmpty(env.RELAYER_PLUGIN_ID);
  const isManagedChannels = relayUrl.hostname
    .toLowerCase()
    .includes(OPENZEPPELIN_CHANNELS_HOSTNAME);
  if (!isManagedChannels && !pluginId) {
    return null;
  }

  const normalizedPath = relayUrl.pathname.replace(/\/+$/g, "");
  relayUrl.pathname = normalizedPath.length > 0 ? normalizedPath : "/";

  return {
    baseUrl: relayUrl.toString(),
    apiKey,
    pluginId,
    timeoutMs: parseInteger(
      env.RELAYER_REQUEST_TIMEOUT_MS,
      DEFAULT_RELAYER_REQUEST_TIMEOUT_MS,
      1_000,
    ),
  };
}

export function resolveDirectClaimConfig(env: WorkerEnv): DirectClaimConfig | null {
  const scoreContractId = nonEmpty(env.SCORE_CONTRACT_ID);
  const channels = resolveChannelsConfig(env);
  if (!scoreContractId || !channels) {
    return null;
  }

  return {
    scoreContractId,
    channels,
  };
}

export function isDirectClaimConfigured(env: WorkerEnv): boolean {
  return resolveDirectClaimConfig(env) !== null;
}

function hexToBytes(hex: string, fieldName: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new Error(`${fieldName} must be a valid even-length hex string`);
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asByte(value: unknown, fieldName: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255) {
    throw new Error(`${fieldName}[${index}] must be a byte`);
  }
  return value & 0xff;
}

function asU32(value: unknown, fieldName: string, index: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${fieldName}[${index}] must be a u32`);
  }
  return value >>> 0;
}

function extractGroth16SealFromProverResponse(proverResponse: unknown): Uint8Array {
  const responseObj = asObject(proverResponse);
  const resultObj = responseObj ? asObject(responseObj.result) : null;
  const proofObj = resultObj ? asObject(resultObj.proof) : null;
  const receiptObj = proofObj ? asObject(proofObj.receipt) : null;
  const innerObj = receiptObj ? asObject(receiptObj.inner) : null;
  const groth16 = innerObj ? asObject(innerObj.Groth16) : null;

  if (!groth16) {
    throw new Error("prover_response.result.proof.receipt.inner.Groth16 is required");
  }

  const seal = groth16.seal;
  const verifierParameters = groth16.verifier_parameters;
  if (!Array.isArray(seal) || seal.length !== 256) {
    throw new Error("receipt.inner.Groth16.seal must be a 256-byte array");
  }
  if (!Array.isArray(verifierParameters) || verifierParameters.length !== 8) {
    throw new Error("receipt.inner.Groth16.verifier_parameters must be an 8-word array");
  }

  const rawSeal = Uint8Array.from(
    seal.map((value, index) => asByte(value, "receipt.inner.Groth16.seal", index)),
  );
  const params = verifierParameters.map((value, index) =>
    asU32(value, "receipt.inner.Groth16.verifier_parameters", index),
  );

  const paramsBytes = new Uint8Array(32);
  const paramsView = new DataView(paramsBytes.buffer);
  for (let index = 0; index < params.length; index += 1) {
    paramsView.setUint32(index * 4, params[index], true);
  }

  const selector = paramsBytes.slice(0, 4);
  const stellarSeal = new Uint8Array(260);
  stellarSeal.set(selector, 0);
  stellarSeal.set(rawSeal, 4);
  return stellarSeal;
}

interface SorobanInvokePayload {
  func: string;
  auth: string[];
}

function retryableChannelsExecutionCode(rawCode: string | null): boolean {
  if (!rawCode) {
    return false;
  }
  const code = rawCode.toLowerCase();
  return (
    code === "pool_capacity" ||
    code === "rate_limit" ||
    code === "locked_conflict" ||
    code === "service_unavailable"
  );
}

function extractExecutionCode(details: unknown): string | null {
  if (!details || typeof details !== "object") {
    return null;
  }
  const code = (details as Record<string, unknown>).code;
  if (typeof code === "string" && code.trim().length > 0) {
    return code.trim();
  }
  return null;
}

/**
 * Extract a Soroban contract error number from SIMULATION_FAILED errorDetails.
 * Channels surfaces these as e.g. "escalating Ok(ScErrorType::Contract) frame-exit to Err (Contract, #3)".
 */
function extractContractErrorCode(errorDetails: unknown): number | null {
  const details = asObject(errorDetails);
  const inner = details ? asObject(details.details) : null;
  const errorStr = inner && typeof inner.error === "string" ? inner.error : null;
  if (!errorStr) return null;
  const match = /\(Contract,\s*#(\d+)\)/.exec(errorStr);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Map a known asteroids-score contract error code to an appropriate RelaySubmitResult.
 *
 * Error codes (from lib.rs #[contracterror]):
 *   1 InvalidJournalLength  — journal not exactly 24 bytes        → fatal
 *   2 InvalidRulesDigest    — wrong rules digest / image id       → fatal
 *   3 JournalAlreadyClaimed — digest already on-chain             → treat as prior success
 *   4 ZeroScoreNotAllowed   — score is 0                          → fatal
 *   5 ScoreNotImproved      — not better than existing best       → treat as superseded
 *   6 ContractPaused        — contract is paused (admin action)   → fatal
 *   7 SeedExpired           — seed no longer valid                → fatal
 */
function classifySimulationContractError(
  contractCode: number,
  errorDetails: unknown,
): RelaySubmitResult {
  const errorDetail = buildErrorDetail({ errorDetails });
  switch (contractCode) {
    case 1:
      return {
        type: "fatal",
        message: "claim rejected: journal data is malformed (InvalidJournalLength)",
        errorDetail,
      };
    case 2:
      return {
        type: "fatal",
        message: "claim rejected: proof rules digest does not match contract (InvalidRulesDigest)",
        errorDetail,
      };
    case 3:
      // Journal digest already exists on-chain — a prior claim attempt succeeded.
      return { type: "success", txHash: "prior-attempt" };
    case 4:
      return {
        type: "fatal",
        message: "claim rejected: score is zero (ZeroScoreNotAllowed)",
        errorDetail,
      };
    case 5:
      // Score did not beat claimant's current best — superseded by a higher score.
      return { type: "success", txHash: "superseded-by-higher-score" };
    case 6:
      return {
        type: "fatal",
        message: "claim rejected: contract is paused (ContractPaused)",
        errorDetail,
      };
    case 7:
      return {
        type: "fatal",
        message: "claim rejected: seed has expired, claim window closed (SeedExpired)",
        errorDetail,
      };
    default:
      return {
        type: "fatal",
        message: `claim rejected: contract error #${contractCode}`,
        errorDetail,
      };
  }
}

/** Deterministic contract / input patterns that should never be retried. */
function hasFatalClaimIndicator(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("error(contract") ||
    m.includes("hosterror") ||
    m.includes("missing proof") ||
    m.includes("required") ||
    m.includes("must be a valid") ||
    m.includes("score not improved") ||
    m.includes("already claimed")
  );
}

function isRetryableChannelsExecution(message: string, code: string | null): boolean {
  // SIMULATION_FAILED is handled via extractContractErrorCode before reaching here;
  // this branch is a fallback for opaque simulation failures with no contract code.
  if (code?.toLowerCase() === "simulation_failed") {
    if (hasFatalClaimIndicator(message)) {
      return false;
    }
    return isRetryableDirectClaimMessage(message);
  }

  if (retryableChannelsExecutionCode(code)) {
    return true;
  }
  // The error code itself may be a known network/transient error (e.g. ECONNRESET).
  if (code && isRetryableDirectClaimMessage(code)) {
    return true;
  }
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("internal error") && normalized.includes("reference")) ||
    normalized.includes("too many transactions queued") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later") ||
    isRetryableDirectClaimMessage(message)
  );
}

function buildChannelsClient(config: ChannelsConfig): ChannelsClient {
  if (config.pluginId) {
    return new ChannelsClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      pluginId: config.pluginId,
      timeout: config.timeoutMs,
    });
  }

  return new ChannelsClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
  });
}

export function isRetryableDirectClaimMessage(rawMessage: string): boolean {
  const message = rawMessage.toLowerCase();

  if (hasFatalClaimIndicator(message)) {
    return false;
  }

  return (
    message.includes("network connection lost") ||
    message.includes("failed to fetch") ||
    (message.includes("internal error") && message.includes("reference")) ||
    message.includes("reference =") ||
    message.includes("network error") ||
    message.includes("networkerror") ||
    message.includes("connection lost") ||
    message.includes("connection reset") ||
    message.includes("connection refused") ||
    message.includes("socket hang up") ||
    message.includes("temporarily unavailable") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("try again later") ||
    message.includes("http 429") ||
    message.includes("http 500") ||
    message.includes("http 502") ||
    message.includes("http 503") ||
    message.includes("http 504")
  );
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildErrorDetail(parts: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(parts)) {
    if (value == null) continue;
    const str = typeof value === "string" ? value : safeJsonStringify(value) ?? String(value);
    if (str.length > 0) lines.push(`${key}: ${str}`);
  }
  return lines.join("\n");
}

async function submitSorobanOperationViaChannels(
  config: ChannelsConfig,
  payload: SorobanInvokePayload,
): Promise<RelaySubmitResult> {
  const client = buildChannelsClient(config);

  try {
    const result = await client.submitSorobanTransaction(payload);

    const txHash = result.hash?.trim() ?? "";
    const status = result.status?.trim().toLowerCase() ?? "";
    if (txHash.length === 0) {
      return {
        type: status === "failed" || status === "error" ? "fatal" : "retry",
        message: "channels relayer accepted soroban transaction but did not return hash",
      };
    }

    return {
      type: "success",
      txHash,
    };
  } catch (error) {
    if (error instanceof PluginTransportError) {
      return {
        type: "retry",
        message: `channels relayer transport failed: ${error.message}`,
        errorDetail: buildErrorDetail({
          category: error.category,
          statusCode: error.statusCode,
          message: error.message,
          errorDetails: error.errorDetails,
          stack: error.stack,
        }),
      };
    }

    if (error instanceof PluginExecutionError) {
      const code = extractExecutionCode(error.errorDetails);

      // For SIMULATION_FAILED, parse the Soroban contract error code first so
      // we can give each outcome a precise classification and message.
      if (code?.toLowerCase() === "simulation_failed") {
        const contractCode = extractContractErrorCode(error.errorDetails);
        if (contractCode !== null) {
          return classifySimulationContractError(contractCode, error.errorDetails);
        }
        // Opaque simulation failure — no contract error code found.
        const isRetryable = !hasFatalClaimIndicator(error.message) &&
          isRetryableDirectClaimMessage(error.message);
        return {
          type: isRetryable ? "retry" : "fatal",
          message: `soroban simulation failed: ${error.message}`,
          errorDetail: buildErrorDetail({
            category: error.category,
            code,
            message: error.message,
            errorDetails: error.errorDetails,
            stack: error.stack,
          }),
        };
      }

      const detail = code ? `${error.message} (${code})` : error.message;
      return {
        type: isRetryableChannelsExecution(error.message, code) ? "retry" : "fatal",
        message: `channels relayer soroban submission failed: ${detail}`,
        errorDetail: buildErrorDetail({
          category: error.category,
          code,
          message: error.message,
          errorDetails: error.errorDetails,
          stack: error.stack,
        }),
      };
    }

    const detail = safeErrorMessage(error);
    return {
      type: isRetryableDirectClaimMessage(detail) ? "retry" : "fatal",
      message: `channels relayer soroban submission failed: ${detail}`,
      errorDetail: buildErrorDetail({
        message: detail,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    };
  }
}

async function buildSubmitScorePayloadViaBindings(
  scoreContractId: string,
  seal: Uint8Array,
  journalRaw: Uint8Array,
  claimantAddress: string,
): Promise<SorobanInvokePayload> {
  const client = new ScoreContractClient({
    contractId: scoreContractId,
    rpcUrl: DEFAULT_BINDINGS_RPC_URL,
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  });

  type SubmitScoreArgs = Parameters<ScoreContractClient["submit_score"]>[0];
  const args: SubmitScoreArgs = {
    seal: seal as unknown as SubmitScoreArgs["seal"],
    journal_raw: journalRaw as unknown as SubmitScoreArgs["journal_raw"],
    claimant: claimantAddress,
  };

  const assembled = await client.submit_score(args, { simulate: false });
  return buildInvokePayloadFromAssembled(
    assembled,
    "generated bindings did not produce invokeHostFunction operation",
  );
}

function buildInvokePayloadFromAssembled(
  assembled: { raw?: { build: () => { operations?: unknown[] } } } | null | undefined,
  onMissingOperationError: string,
): SorobanInvokePayload {
  const built = assembled?.raw?.build();
  const operation = built?.operations?.[0] as
    | {
        func?: xdr.HostFunction;
        auth?: xdr.SorobanAuthorizationEntry[];
      }
    | undefined;

  if (!operation?.func) {
    throw new Error(onMissingOperationError);
  }

  const authEntries = Array.isArray(operation.auth) ? operation.auth : [];
  return {
    func: operation.func.toXDR("base64"),
    auth: authEntries.map((entry) => entry.toXDR("base64")),
  };
}

async function fetchWindowSeed(contractId: string, window: number): Promise<number | null> {
  const server = new rpc.Server(DEFAULT_BINDINGS_RPC_URL, {
    allowHttp: DEFAULT_BINDINGS_RPC_URL.startsWith("http:"),
  });
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("ValidSeed"), xdr.ScVal.scvU32(window)]);

  try {
    const entry = await server.getContractData(contractId, key, rpc.Durability.Temporary);
    const value = entry.val.contractData().val();
    if (value.switch().name !== "scvU32") {
      return null;
    }
    return value.u32() >>> 0;
  } catch {
    return null;
  }
}

export async function submitSeedRefresh(env: WorkerEnv): Promise<void> {
  const config = resolveDirectClaimConfig(env);
  if (!config) {
    console.log("[seed-refresh] channels relayer not configured, skipping seed refresh");
    return;
  }

  let phase = "init";
  try {
    phase = "build_payload_current_seed";
    const client = new ScoreContractClient({
      contractId: config.scoreContractId,
      rpcUrl: DEFAULT_BINDINGS_RPC_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
    });
    const assembled = await client.current_seed({ simulate: false });
    const payload = buildInvokePayloadFromAssembled(
      assembled,
      "current_seed invocation did not produce invokeHostFunction operation",
    );

    console.log("[seed-refresh] submitting current_seed() to materialize window seed", {
      contractId: config.scoreContractId,
      relayerUrl: config.channels.baseUrl,
    });

    phase = "send_tx_current_seed";
    const result = await submitSorobanOperationViaChannels(config.channels, payload);

    if (result.type !== "success") {
      console.warn("[seed-refresh] seed materialization failed", {
        type: result.type,
        message: result.message,
      });
      return;
    }

    const nowWindow = Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
    const candidateWindows = nowWindow > 0 ? [nowWindow, nowWindow - 1] : [nowWindow];

    phase = "fetch_window_seed";
    let window: number | null = null;
    let seed: number | null = null;
    for (const candidateWindow of candidateWindows) {
      const candidateSeed = await fetchWindowSeed(config.scoreContractId, candidateWindow);
      if (candidateSeed !== null) {
        window = candidateWindow;
        seed = candidateSeed;
        break;
      }
    }
    if (window === null || seed === null) {
      console.warn("[seed-refresh] unable to read ValidSeed(window) after materialization", {
        triedWindows: candidateWindows,
      });
      return;
    }

    phase = "build_payload_index_seed";
    const indexAssembled = await client.index_seed(
      { window: window >>> 0, seed },
      { simulate: false },
    );
    const indexPayload = buildInvokePayloadFromAssembled(
      indexAssembled,
      "index_seed invocation did not produce invokeHostFunction operation",
    );

    console.log("[seed-refresh] submitting index_seed(window, seed)", {
      window,
      seed,
    });

    phase = "send_tx_index_seed";
    const indexResult = await submitSorobanOperationViaChannels(config.channels, indexPayload);
    if (indexResult.type === "success") {
      console.log("[seed-refresh] seed materialized and indexed successfully", {
        txHashCurrentSeed: result.txHash,
        txHashIndexSeed: indexResult.txHash,
        window,
        seed,
      });
      return;
    }

    console.warn("[seed-refresh] seed indexed failed after materialization", {
      type: indexResult.type,
      message: indexResult.message,
      window,
      seed,
      txHashCurrentSeed: result.txHash,
    });
  } catch (error) {
    console.error(`[seed-refresh] error during ${phase}: ${safeErrorMessage(error)}`);
  }
}

export async function submitClaimDirect(
  env: WorkerEnv,
  request: RelayClaimRequest,
): Promise<RelaySubmitResult> {
  const config = resolveDirectClaimConfig(env);
  if (!config) {
    return {
      type: "fatal",
      message:
        "direct claim is not configured; set SCORE_CONTRACT_ID, RELAYER_URL, and RELAYER_API_KEY for relayer-only submission",
    };
  }

  let phase = "init";
  try {
    phase = "parse_payload";
    const seal = extractGroth16SealFromProverResponse(request.proverResponse);
    const journalRaw = hexToBytes(request.journalRawHex, "journal_raw_hex");
    // Validate claimant formatting before constructing invoke payload.
    Address.fromString(request.claimantAddress);

    phase = "build_payload_bindings";
    const payload = await buildSubmitScorePayloadViaBindings(
      config.scoreContractId,
      seal,
      journalRaw,
      request.claimantAddress,
    );

    console.log("[claim-direct] relayer-only submit", {
      jobId: request.jobId,
      relayerUrl: config.channels.baseUrl,
      claimant: request.claimantAddress,
      journalDigestHex: request.journalDigestHex,
      journalBytes: journalRaw.length,
      sealBytes: seal.length,
      authEntries: payload.auth.length,
    });

    phase = "send_tx_channels_soroban";
    return submitSorobanOperationViaChannels(config.channels, payload);
  } catch (error) {
    const detail = safeErrorMessage(error);
    console.error("[claim-direct] submit failed", {
      jobId: request.jobId,
      phase,
      message: detail,
    });

    const retryable = isRetryableDirectClaimMessage(detail);
    return {
      type: retryable ? "retry" : "fatal",
      message: `direct claim failed during ${phase}: ${detail}`,
      errorDetail: buildErrorDetail({
        phase,
        message: detail,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    };
  }
}
