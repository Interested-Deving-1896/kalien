import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { applyApiCacheControl } from "./cache-control";
export { ProofCoordinatorDO } from "./durable/coordinator";
import type { WorkerEnv } from "./env";
import { createApiRouter } from "./api/routes";
import { createLeaderboardPublicRouter } from "./api/leaderboard-routes";
import { coordinatorStub } from "./durable/coordinator";
import { recordLeaderboardSyncFailure, runScheduledLeaderboardSync } from "./leaderboard-sync";
import {
  handleClaimDlqBatch,
  handleClaimQueueBatch,
  handleDlqBatch,
  handleQueueBatch,
  handleVastQueueBatch,
} from "./queue/consumer";
import { ensureCurrentEpochSeed } from "./claim/direct";
import type { ClaimQueueMessage, ProofQueueMessage } from "./types";
import { safeErrorMessage } from "./utils";

const app = new Hono<{ Bindings: WorkerEnv }>();
const LEADERBOARD_SYNC_CRON = "*/1 * * * *";
const SEED_REFRESH_CRON = "*/10 * * * *";
const STELLAR_TOML_PATH = "/.well-known/stellar.toml";

function applyStellarTomlHeaders(headers: Headers): void {
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("cache-control", "public, max-age=300");
  headers.set("x-content-type-options", "nosniff");
}

app.options(STELLAR_TOML_PATH, () => {
  const headers = new Headers();
  applyStellarTomlHeaders(headers);
  return new Response(null, { status: 204, headers });
});

app.get(STELLAR_TOML_PATH, async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(assetResponse.headers);
  applyStellarTomlHeaders(headers);

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

app.use("/api/*", async (c, next) => {
  await next();
  c.res = applyApiCacheControl(c.res);
});

app.route("/api", createApiRouter());
app.route("/api/leaderboard", createLeaderboardPublicRouter());

// Dev-only: manually trigger leaderboard sync (requires DEV_API_KEY)
app.post("/api/dev/sync", async (c) => {
  const key = c.env.DEV_API_KEY;
  if (!key) return c.json({ success: false, error: "endpoint disabled" }, 404);
  const auth = c.req.header("authorization");
  if (auth !== `Bearer ${key}`) return c.json({ success: false, error: "unauthorized" }, 401);

  const result = await runScheduledLeaderboardSync(c.env, Date.now());
  return c.json({ success: true, result });
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(
      {
        success: false,
        error: `unknown api route: ${c.req.path}`,
      },
      404,
    );
  }

  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    if (c.req.path.startsWith("/api/")) {
      return applyApiCacheControl(response);
    }
    return response;
  }

  console.error(`[proof-worker] ${safeErrorMessage(error)}`);

  if (c.req.path.startsWith("/api/")) {
    return c.json(
      {
        success: false,
        error: "internal server error",
      },
      500,
    );
  }

  return new Response("Internal Server Error", { status: 500 });
});

export default {
  fetch(
    request: Request,
    env: WorkerEnv,
    executionCtx: ExecutionContext,
  ): Response | Promise<Response> {
    return app.fetch(request, env, executionCtx);
  },

  async queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    if (batch.queue.endsWith("-proof-jobs-dlq")) {
      await handleDlqBatch(batch as MessageBatch<ProofQueueMessage>, env);
    } else if (batch.queue.endsWith("-vast-jobs")) {
      await handleVastQueueBatch(batch as MessageBatch<ProofQueueMessage>, env);
    } else if (batch.queue.endsWith("-vast-jobs-dlq")) {
      await handleDlqBatch(batch as MessageBatch<ProofQueueMessage>, env);
    } else if (batch.queue.endsWith("-claim-jobs")) {
      await handleClaimQueueBatch(batch as MessageBatch<ClaimQueueMessage>, env);
    } else if (batch.queue.endsWith("-claim-jobs-dlq")) {
      await handleClaimDlqBatch(batch as MessageBatch<ClaimQueueMessage>, env);
    } else {
      await handleQueueBatch(batch as MessageBatch<ProofQueueMessage>, env);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    _executionCtx: ExecutionContext,
  ): Promise<void> {
    try {
      await coordinatorStub(env).runMaintenance();
    } catch (error) {
      console.warn(`[proof-worker] coordinator maintenance failed: ${safeErrorMessage(error)}`);
    }

    const cronSpec = controller.cron ?? null;
    const runSeedRefresh = cronSpec === null || cronSpec === SEED_REFRESH_CRON;
    const runLeaderboardSync = cronSpec === null || cronSpec === LEADERBOARD_SYNC_CRON;

    if (!runSeedRefresh && !runLeaderboardSync) {
      console.warn(`[scheduled] ignoring unrecognized cron spec: ${cronSpec}`);
      return;
    }

    if (runSeedRefresh) {
      // Materialize/index the on-chain seed for the current 10-min window so
      // players don't need to trigger seed creation themselves.
      // Retry up to 3 times with short gaps under a strict wall-time budget;
      // if all fail the next cron tick (every 10 min) will try again.
      let seedRefreshSucceeded = false;
      let lastSeedRefreshFailure: string | null = null;
      const SEED_REFRESH_MAX_ATTEMPTS = 3;
      const SEED_REFRESH_RETRY_DELAY_MS = 3_000;
      const SEED_REFRESH_HANDLER_BUDGET_MS = 20_000;
      const SEED_REFRESH_MAX_FETCH_TIMEOUT_MS = 5_000;
      const seedRefreshDeadlineMs = Date.now() + SEED_REFRESH_HANDLER_BUDGET_MS;
      for (let attempt = 1; attempt <= SEED_REFRESH_MAX_ATTEMPTS; attempt++) {
        if (Date.now() >= seedRefreshDeadlineMs) {
          lastSeedRefreshFailure = "seed refresh cron budget exceeded";
          console.warn(
            `[seed-refresh] stopping retries: ${lastSeedRefreshFailure} (${SEED_REFRESH_HANDLER_BUDGET_MS}ms)`,
          );
          break;
        }

        // eslint-disable-next-line no-await-in-loop -- intentional sequential retry with backoff
        const seedResult = await ensureCurrentEpochSeed(env, {
          deadlineMs: seedRefreshDeadlineMs,
          maxFetchTimeoutMs: SEED_REFRESH_MAX_FETCH_TIMEOUT_MS,
        }).catch((error) => ({
          success: false,
          message: safeErrorMessage(error),
        }));
        if (seedResult.success) {
          seedRefreshSucceeded = true;
          break;
        }
        lastSeedRefreshFailure = seedResult.message ?? "unknown";
        console.warn(
          `[seed-refresh] attempt ${attempt}/${SEED_REFRESH_MAX_ATTEMPTS} failed: ${seedResult.message ?? "unknown"}`,
        );
        if (attempt < SEED_REFRESH_MAX_ATTEMPTS) {
          const remainingMs = seedRefreshDeadlineMs - Date.now();
          if (remainingMs < SEED_REFRESH_RETRY_DELAY_MS) {
            lastSeedRefreshFailure = "seed refresh cron budget exhausted before next retry";
            console.warn(
              `[seed-refresh] stopping retries: ${lastSeedRefreshFailure} (${SEED_REFRESH_HANDLER_BUDGET_MS}ms)`,
            );
            break;
          }
          // eslint-disable-next-line no-await-in-loop -- intentional sequential retry with backoff
          await new Promise((r) => setTimeout(r, SEED_REFRESH_RETRY_DELAY_MS));
        }
      }
      if (!seedRefreshSucceeded) {
        console.warn(
          `[seed-refresh] scheduled refresh failed after ${SEED_REFRESH_MAX_ATTEMPTS} attempts: ${
            lastSeedRefreshFailure ?? "unknown"
          }`,
        );
      }
    }

    if (!runLeaderboardSync) {
      return;
    }

    try {
      const result = await runScheduledLeaderboardSync(env, controller.scheduledTime);
      if (!result.enabled) {
        return;
      }

      if (result.warning) {
        console.warn(`[leaderboard-sync] ${result.warning}`);
      }
    } catch (error) {
      try {
        await recordLeaderboardSyncFailure(env, error);
      } catch (recordError) {
        console.error(
          `[leaderboard-sync] failed recording scheduled sync error: ${safeErrorMessage(recordError)}`,
        );
      }
      console.error(`[leaderboard-sync] scheduled sync failed: ${safeErrorMessage(error)}`);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
