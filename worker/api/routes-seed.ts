import { Hono } from "hono";
import { ensureCurrentEpochSeed, readCurrentEpochSeedState } from "../claim/direct";
import type { WorkerEnv } from "../env";
import { safeErrorMessage } from "../utils";

function jsonError(
  c: { json: (body: unknown, status?: number) => Response },
  status: number,
  error: string,
): Response {
  return c.json(
    {
      success: false,
      error,
    },
    status,
  );
}

export function createSeedRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  router.get("/current", async (c) => {
    let state: Awaited<ReturnType<typeof readCurrentEpochSeedState>>;
    try {
      state = await readCurrentEpochSeedState(c.env);
    } catch (error) {
      return jsonError(c, 503, safeErrorMessage(error));
    }

    return c.json({
      success: true,
      seed_id: state.seedId,
      seconds_left: state.secondsLeft,
      seed: state.seed,
      indexed: state.seed !== null,
    });
  });

  router.post("/refresh", async (c) => {
    // ensureCurrentEpochSeed already checks if the seed exists
    // and has its own cooldown logic — no need to pre-check here.
    let result;
    try {
      result = await ensureCurrentEpochSeed(c.env);
    } catch (error) {
      return jsonError(c, 503, safeErrorMessage(error));
    }

    if (!result.success) {
      if (result.retryAfterSeconds && result.retryAfterSeconds > 0) {
        c.header("Retry-After", String(result.retryAfterSeconds));
      }
      return c.json(
        {
          success: false,
          error: result.message ?? "unable to create current epoch seed",
          seed_id: result.state.seedId,
          seconds_left: result.state.secondsLeft,
          seed: result.state.seed,
          indexed: result.state.seed !== null,
          refresh_attempted: result.refreshAttempted,
          refreshed: result.refreshed,
          tx_hash_current_seed: result.txHashCurrentSeed,
          retry_after_seconds: result.retryAfterSeconds ?? null,
        },
        result.retryAfterSeconds ? 429 : 503,
      );
    }

    return c.json({
      success: true,
      seed_id: result.state.seedId,
      seconds_left: result.state.secondsLeft,
      seed: result.state.seed,
      indexed: result.state.seed !== null,
      refresh_attempted: result.refreshAttempted,
      refreshed: result.refreshed,
      message: result.message,
      tx_hash_current_seed: result.txHashCurrentSeed,
    });
  });

  return router;
}
