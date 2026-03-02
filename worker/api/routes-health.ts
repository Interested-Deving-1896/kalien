import { Hono } from "hono";
import { createPublicClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { boundlessMarketAbi } from "../boundless/abi";
import { resolveBoundlessConfig } from "../boundless/config";
import { EXPECTED_RULES_DIGEST, EXPECTED_RULESET } from "../constants";
import { HEALTH_CACHE_CONTROL } from "../cache-control";
import { coordinatorStub } from "../durable/coordinator";
import type { WorkerEnv } from "../env";
import { describeProverHealthError, getValidatedProverHealth } from "../prover/client";
import { safeErrorMessage } from "../utils";

export function createHealthRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  router.get("/", async (c) => {
    const coordinator = coordinatorStub(c.env);
    const activeSummary = await coordinator.getActiveJobsSummary();
    const boundlessConfig = resolveBoundlessConfig(c.env);
    const hasBoundless = boundlessConfig !== null;
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

    let boundlessFunding:
      | {
          status: "disabled";
          mode: null;
          top_up_buffer_bps: null;
          attached_value_fallback_enabled: null;
          requestor_address: null;
          market_balance_wei: null;
          market_balance_eth: null;
          error: null;
        }
      | {
          status: "ok" | "degraded";
          mode: "market_balance_with_attached_value_fallback";
          top_up_buffer_bps: number;
          attached_value_fallback_enabled: true;
          requestor_address: string | null;
          market_balance_wei: string | null;
          market_balance_eth: string | null;
          error: string | null;
        };

    if (!boundlessConfig) {
      boundlessFunding = {
        status: "disabled",
        mode: null,
        top_up_buffer_bps: null,
        attached_value_fallback_enabled: null,
        requestor_address: null,
        market_balance_wei: null,
        market_balance_eth: null,
        error: null,
      };
    } else {
      let requestor: `0x${string}` | null = null;
      let marketBalanceWei: string | null = null;
      let marketBalanceEth: string | null = null;
      let status: "ok" | "degraded" = "ok";
      let error: string | null = null;

      try {
        requestor = privateKeyToAccount(boundlessConfig.privateKey).address;
      } catch (err) {
        status = "degraded";
        error = `invalid BOUNDLESS_PRIVATE_KEY: ${safeErrorMessage(err)}`;
      }

      if (!error && requestor) {
        try {
          const chain = defineChain({
            id: Number(boundlessConfig.chainId),
            name: `chain-${boundlessConfig.chainId}`,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [boundlessConfig.rpcUrl] } },
          });

          const client = createPublicClient({
            chain,
            transport: http(boundlessConfig.rpcUrl),
          });

          const balance = await client.readContract({
            address: boundlessConfig.marketAddress,
            abi: boundlessMarketAbi,
            functionName: "balanceOf",
            args: [requestor],
          });
          marketBalanceWei = balance.toString();
          marketBalanceEth = formatEther(balance);
        } catch (err) {
          status = "degraded";
          error = safeErrorMessage(err);
        }
      }

      boundlessFunding = {
        status,
        mode: "market_balance_with_attached_value_fallback",
        top_up_buffer_bps: boundlessConfig.topUpBufferBps,
        attached_value_fallback_enabled: true,
        requestor_address: requestor,
        market_balance_wei: marketBalanceWei,
        market_balance_eth: marketBalanceEth,
        error,
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
      boundless_funding: boundlessFunding,
    });
  });

  return router;
}
