import { Hono } from "hono";
import { resolveBoundlessConfig } from "../boundless/config";
import { EXPECTED_RULES_DIGEST, EXPECTED_RULESET } from "../constants";
import { HEALTH_CACHE_CONTROL } from "../cache-control";
import { coordinatorStub } from "../durable/coordinator";
import type { WorkerEnv } from "../env";
import { describeProverHealthError, getValidatedProverHealth } from "../prover/client";

export function createHealthRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  router.get("/", async (c) => {
    const coordinator = coordinatorStub(c.env);
    const activeSummary = await coordinator.getActiveJobsSummary();
    const hasBoundless = resolveBoundlessConfig(c.env) !== null;
    const hasVast = Boolean(c.env.PROVER_BASE_URL?.trim());
    const expectedImageIdRaw = c.env.PROVER_EXPECTED_IMAGE_ID?.trim() ?? "";
    const expectedImageId = expectedImageIdRaw.length > 0 ? expectedImageIdRaw : null;

    let prover:
      | {
          status: "compatible";
          image_id: string;
          rules_digest_hex: string;
          ruleset: string;
        }
      | {
          status: "degraded";
          error: string;
        };

    try {
      const health = await getValidatedProverHealth(c.env);
      prover = {
        status: "compatible",
        image_id: health.imageId,
        rules_digest_hex: health.rulesDigestHex,
        ruleset: health.ruleset,
      };
    } catch (error) {
      const healthError = describeProverHealthError(error);
      prover = {
        status: "degraded",
        error: healthError.message,
      };
    }

    c.header("Cache-Control", HEALTH_CACHE_CONTROL);
    return c.json({
      success: true,
      service: "kalien-proof-gateway",
      mode: "queue-coordinated",
      expected: {
        rules_digest_hex: `0x${(EXPECTED_RULES_DIGEST >>> 0).toString(16).padStart(8, "0")}`,
        ruleset: EXPECTED_RULESET,
        image_id: expectedImageId,
      },
      checked_at: new Date().toISOString(),
      prover,
      active_jobs: activeSummary.total,
      active_job_id: activeSummary.firstJobId,
      oldest_active_job_age_sec: activeSummary.oldestActiveAgeSec,
      oldest_waiting_dispatch_age_sec: activeSummary.oldestWaitingDispatchAgeSec,
      active_jobs_by_backend: {
        boundless: activeSummary.boundless,
        vast: activeSummary.vast,
        waiting_dispatch: activeSummary.waitingDispatch,
      },
      active_jobs_by_status: {
        queued: activeSummary.statusCounts.queued,
        dispatching: activeSummary.statusCounts.dispatching,
        prover_running: activeSummary.statusCounts.proverRunning,
        retrying: activeSummary.statusCounts.retrying,
      },
      configured_backends: {
        boundless: hasBoundless,
        vast: hasVast,
      },
    });
  });

  return router;
}
