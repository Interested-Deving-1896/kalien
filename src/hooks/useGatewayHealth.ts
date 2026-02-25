import { useEffect, useState } from "react";
import {
  getGatewayHealth,
  type GatewayHealthResponse,
  type ProofJobPublic,
} from "../proof/api";
import {
  GATEWAY_HEALTH_INITIAL_POLL_DELAY_MS,
  GATEWAY_HEALTH_POLL_INTERVAL_MS,
} from "../consts";

export interface UseGatewayHealthReturn {
  health: GatewayHealthResponse | null;
  isHealthy: boolean;
  error: string | null;
  activeJob: ProofJobPublic | null;
}

export function useGatewayHealth(): UseGatewayHealthReturn {
  const [health, setHealth] = useState<GatewayHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const pollHealth = async () => {
      try {
        const response = await getGatewayHealth();
        if (cancelled) {
          return;
        }
        setHealth(response);
        setError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : "failed to refresh gateway health";
        setError(message);
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(pollHealth, GATEWAY_HEALTH_POLL_INTERVAL_MS);
        }
      }
    };

    timeoutId = window.setTimeout(pollHealth, GATEWAY_HEALTH_INITIAL_POLL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  const isHealthy = health?.prover.status === "compatible";
  const activeJob = health?.active_job ?? null;

  return {
    health,
    isHealthy,
    error,
    activeJob,
  };
}
