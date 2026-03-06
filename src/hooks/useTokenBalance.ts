import { useCallback, useEffect, useRef, useState } from "react";
import {
  getScoreContractIdFromEnv,
  getTokenContractIdFromEnv,
  readTokenBalance,
} from "../chain/token";
import { formatWholeNumber, toDisplayKalien } from "../lib/format";

export interface UseTokenBalanceReturn {
  balance: bigint | null;
  formattedBalance: string;
  tokenContractId: string | null;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTokenBalance(walletAddress: string): UseTokenBalanceReturn {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [tokenContractId, setTokenContractId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshRequestIdRef = useRef(0);

  const scoreContractId = getScoreContractIdFromEnv();
  const tokenContractOverride = getTokenContractIdFromEnv();

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    if (walletAddress.trim().length === 0) {
      setBalance(null);
      setTokenContractId(null);
      setError(null);
      setIsRefreshing(false);
      return;
    }

    if (!scoreContractId && !tokenContractOverride) {
      setBalance(null);
      setTokenContractId(null);
      setError(
        "set VITE_SCORE_CONTRACT_ID (or VITE_TOKEN_CONTRACT_ID) to show on-chain token balance",
      );
      setIsRefreshing(false);
      return;
    }

    setIsRefreshing(true);
    try {
      const next = await readTokenBalance({
        walletAddress,
        scoreContractId,
        tokenContractId: tokenContractOverride,
      });
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }
      setBalance(next.balance);
      setTokenContractId(next.tokenContractId);
      setError(null);
    } catch (err) {
      if (requestId !== refreshRequestIdRef.current) {
        return;
      }
      const detail = err instanceof Error ? err.message : "failed to load token balance";
      setError(detail);
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [walletAddress, scoreContractId, tokenContractOverride]);

  // Auto-refresh when wallet address changes
  useEffect(() => {
    if (walletAddress.trim().length === 0) {
      refreshRequestIdRef.current += 1;
      setBalance(null);
      setTokenContractId(null);
      setError(null);
      setIsRefreshing(false);
      return;
    }

    void refresh();
  }, [walletAddress, refresh]);

  const formattedBalance =
    balance === null ? "\u2014" : `${formatWholeNumber(toDisplayKalien(balance))} KALIEN`;

  return {
    balance,
    formattedBalance,
    tokenContractId,
    isRefreshing,
    error,
    refresh,
  };
}
