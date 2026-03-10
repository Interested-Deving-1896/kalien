import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBestScoreForSeed } from "@/chain/seed";
import { getScoreContractIdFromEnv } from "@/chain/token";

const STORAGE_KEY_PREFIX = "kalien:endless-seed-best:v1";

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getRpcUrlFromEnv(): string | null {
  return nonEmpty(import.meta.env.VITE_RPC_URL);
}

function getStorageKey(walletAddress: string, networkPassphrase: string): string | null {
  const address = nonEmpty(walletAddress);
  if (!address) {
    return null;
  }
  const network = nonEmpty(networkPassphrase) ?? "unknown-network";
  return `${STORAGE_KEY_PREFIX}:${network}:${address}`;
}

function readStoredSeedScores(storageKey: string | null): Record<string, number> {
  if (typeof window === "undefined" || !storageKey) {
    return {};
  }

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, number> = {};
    for (const [seedId, value] of Object.entries(parsed)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        continue;
      }
      next[seedId] = value >>> 0;
    }
    return next;
  } catch {
    return {};
  }
}

function writeStoredSeedScore(storageKey: string | null, seedId: number, score: number): void {
  if (typeof window === "undefined" || !storageKey) {
    return;
  }

  const normalizedSeedId = seedId >>> 0;
  const normalizedScore = score >>> 0;
  const next = readStoredSeedScores(storageKey);
  next[String(normalizedSeedId)] = normalizedScore;

  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Ignore sessionStorage quota/security failures; endless mode can still use in-memory state.
  }
}

function getStoredSeedScore(storageKey: string | null, seedId: number): number {
  const stored = readStoredSeedScores(storageKey)[String(seedId >>> 0)];
  return typeof stored === "number" && Number.isFinite(stored) ? stored >>> 0 : 0;
}

export function commitFetchedSeedScore(
  storageKey: string | null,
  cache: Map<number, number>,
  readySeedIds: Set<number>,
  seedId: number,
  bestScore: number,
  onChainBest: number | null,
): number | null {
  const normalizedSeedId = seedId >>> 0;
  if (onChainBest === null) {
    return null;
  }

  const normalizedBestScore = bestScore >>> 0;
  cache.set(normalizedSeedId, normalizedBestScore);
  writeStoredSeedScore(storageKey, normalizedSeedId, normalizedBestScore);
  readySeedIds.add(normalizedSeedId);
  return normalizedBestScore;
}

export interface UseEndlessSeedScoreGateOptions {
  enabled: boolean;
  walletAddress: string;
  walletConnected: boolean;
  networkPassphrase: string;
  currentSeedId: number | null;
}

export interface UseEndlessSeedScoreGateReturn {
  currentSeedScoreToBeat: number;
  isCurrentSeedScoreLoading: boolean;
  isCurrentSeedScoreReady: boolean;
  getKnownSeedScoreToBeat: (seedId: number) => number;
  refreshSeedScoreToBeat: (seedId: number, options?: { force?: boolean }) => Promise<number | null>;
  noteSubmittedScore: (seedId: number, score: number) => void;
}

export function useEndlessSeedScoreGate({
  enabled,
  walletAddress,
  walletConnected,
  networkPassphrase,
  currentSeedId,
}: UseEndlessSeedScoreGateOptions): UseEndlessSeedScoreGateReturn {
  const storageKey = getStorageKey(walletAddress, networkPassphrase);
  const cacheRef = useRef(new Map<number, number>());
  const readySeedIdsRef = useRef(new Set<number>());
  const inFlightRef = useRef(new Map<number, Promise<number | null>>());
  const contextVersionRef = useRef(0);
  const [currentSeedScoreToBeat, setCurrentSeedScoreToBeat] = useState(0);
  const [isCurrentSeedScoreLoading, setIsCurrentSeedScoreLoading] = useState(false);
  const [isCurrentSeedScoreReady, setIsCurrentSeedScoreReady] = useState(false);

  useEffect(() => {
    contextVersionRef.current += 1;
    cacheRef.current.clear();
    readySeedIdsRef.current.clear();
    inFlightRef.current.clear();
    setCurrentSeedScoreToBeat(0);
    setIsCurrentSeedScoreLoading(false);
    setIsCurrentSeedScoreReady(false);
  }, [storageKey]);

  const noteSubmittedScore = useCallback(
    (seedId: number, score: number) => {
      const normalizedSeedId = seedId >>> 0;
      const nextScore = Math.max(
        cacheRef.current.get(normalizedSeedId) ?? 0,
        getStoredSeedScore(storageKey, normalizedSeedId),
        score >>> 0,
      );
      cacheRef.current.set(normalizedSeedId, nextScore);
      writeStoredSeedScore(storageKey, normalizedSeedId, nextScore);

      if (currentSeedId !== null && currentSeedId >>> 0 === normalizedSeedId) {
        setCurrentSeedScoreToBeat(nextScore);
      }
    },
    [currentSeedId, storageKey],
  );

  const getKnownSeedScoreToBeat = useCallback(
    (seedId: number): number => {
      const normalizedSeedId = seedId >>> 0;
      return Math.max(
        cacheRef.current.get(normalizedSeedId) ?? 0,
        getStoredSeedScore(storageKey, normalizedSeedId),
      );
    },
    [storageKey],
  );

  const refreshSeedScoreToBeat = useCallback(
    async (seedId: number, options?: { force?: boolean }): Promise<number | null> => {
      const normalizedSeedId = seedId >>> 0;
      const cachedBest = getKnownSeedScoreToBeat(normalizedSeedId);
      if (!walletConnected || !nonEmpty(walletAddress)) {
        return cachedBest;
      }

      const inFlight = inFlightRef.current.get(normalizedSeedId);
      if (inFlight) {
        return inFlight;
      }

      if (!options?.force) {
        const cached = cacheRef.current.get(normalizedSeedId);
        if (
          readySeedIdsRef.current.has(normalizedSeedId) &&
          typeof cached === "number" &&
          Number.isFinite(cached)
        ) {
          return Math.max(cached >>> 0, cachedBest);
        }
      }

      const requestVersion = contextVersionRef.current;
      const request = (async () => {
        let bestScore = 0;
        let onChainBest: number | null = null;
        const scoreContractId = getScoreContractIdFromEnv();
        const rpcUrl = getRpcUrlFromEnv();
        const isStale = () => contextVersionRef.current !== requestVersion;

        if (scoreContractId && rpcUrl) {
          onChainBest = await fetchBestScoreForSeed(
            scoreContractId,
            rpcUrl,
            walletAddress,
            normalizedSeedId,
          );
          if (isStale()) {
            return null;
          }
          if (typeof onChainBest === "number") {
            bestScore = Math.max(bestScore, onChainBest >>> 0);
          }
        }

        if (isStale()) {
          return null;
        }

        return commitFetchedSeedScore(
          storageKey,
          cacheRef.current,
          readySeedIdsRef.current,
          normalizedSeedId,
          bestScore,
          onChainBest,
        );
      })().finally(() => {
        inFlightRef.current.delete(normalizedSeedId);
      });

      inFlightRef.current.set(normalizedSeedId, request);
      return request;
    },
    [getKnownSeedScoreToBeat, storageKey, walletAddress, walletConnected],
  );

  useEffect(() => {
    if (!enabled || !walletConnected || currentSeedId === null) {
      setIsCurrentSeedScoreLoading(false);
      setIsCurrentSeedScoreReady(false);
      setCurrentSeedScoreToBeat(0);
      return;
    }

    const normalizedSeedId = currentSeedId >>> 0;
    const knownBest = getKnownSeedScoreToBeat(normalizedSeedId);
    setCurrentSeedScoreToBeat(knownBest);
    setIsCurrentSeedScoreLoading(true);
    setIsCurrentSeedScoreReady(false);

    let cancelled = false;
    void (async () => {
      try {
        const scoreToBeat = await refreshSeedScoreToBeat(normalizedSeedId);
        if (cancelled) {
          return;
        }
        setCurrentSeedScoreToBeat(
          typeof scoreToBeat === "number" ? scoreToBeat : getKnownSeedScoreToBeat(normalizedSeedId),
        );
        setIsCurrentSeedScoreReady(typeof scoreToBeat === "number");
        setIsCurrentSeedScoreLoading(false);
      } catch {
        if (cancelled) {
          return;
        }
        setCurrentSeedScoreToBeat(getKnownSeedScoreToBeat(normalizedSeedId));
        setIsCurrentSeedScoreReady(false);
        setIsCurrentSeedScoreLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentSeedId, enabled, getKnownSeedScoreToBeat, refreshSeedScoreToBeat, walletConnected]);

  return {
    currentSeedScoreToBeat,
    isCurrentSeedScoreLoading,
    isCurrentSeedScoreReady,
    getKnownSeedScoreToBeat,
    refreshSeedScoreToBeat,
    noteSubmittedScore,
  };
}
