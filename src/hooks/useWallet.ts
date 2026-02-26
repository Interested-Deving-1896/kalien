import { useCallback, useEffect, useState } from "react";
import type {
  SmartAccountConfig,
  SmartAccountRelayerMode,
  SmartWalletSession,
} from "../wallet/smartAccount";
import { loadSmartWalletModule } from "../wallet/loader";
import { TESTNET_NETWORK_PASSPHRASE } from "../consts";

export type WalletAction = "idle" | "restoring" | "connecting" | "creating" | "disconnecting";

export interface UseWalletReturn {
  session: SmartWalletSession | null;
  isConnected: boolean;
  isBusy: boolean;
  action: WalletAction;
  error: string | null;
  address: string;
  relayerMode: SmartAccountRelayerMode;
  networkPassphrase: string;
  userName: string;
  setUserName: (name: string) => void;
  connect: () => Promise<void>;
  create: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearError: () => void;
}

export function useWallet(): UseWalletReturn {
  const [session, setSession] = useState<SmartWalletSession | null>(null);
  const [action, setAction] = useState<WalletAction>("idle");
  const [userName, setUserName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Pick<SmartAccountConfig, "networkPassphrase">>({
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  });
  const [relayerMode, setRelayerMode] = useState<SmartAccountRelayerMode>("disabled");

  const address = session?.contractId ?? "";
  const isConnected = address.trim().length > 0;
  const isBusy = action !== "idle";

  const connect = useCallback(async () => {
    setAction("connecting");
    setError(null);

    try {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      setConfig({ networkPassphrase: nextConfig.networkPassphrase });
      setRelayerMode(walletModule.getSmartAccountRelayerMode());
      const nextSession = await walletModule.connectSmartWallet();
      setSession(nextSession);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "failed to connect wallet";
      setError(detail);
    } finally {
      setAction("idle");
    }
  }, []);

  const create = useCallback(async () => {
    setAction("creating");
    setError(null);

    try {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      setConfig({ networkPassphrase: nextConfig.networkPassphrase });
      setRelayerMode(walletModule.getSmartAccountRelayerMode());
      const nextSession = await walletModule.createSmartWallet(userName);
      setSession(nextSession);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "failed to create wallet";
      setError(detail);
    } finally {
      setAction("idle");
    }
  }, [userName]);

  const disconnect = useCallback(async () => {
    setAction("disconnecting");
    setError(null);

    try {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      setConfig({ networkPassphrase: nextConfig.networkPassphrase });
      setRelayerMode(walletModule.getSmartAccountRelayerMode());
      await walletModule.disconnectSmartWallet();
      setSession(null);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "failed to disconnect wallet";
      setError(detail);
    } finally {
      setAction("idle");
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Restore session on mount
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      setAction("restoring");
      setError(null);

      try {
        const walletModule = await loadSmartWalletModule();
        const nextConfig = walletModule.getSmartAccountConfig();
        const nextRelayerMode = walletModule.getSmartAccountRelayerMode();
        const restoredSession = await walletModule.restoreSmartWalletSession();
        if (cancelled) {
          return;
        }
        setConfig({ networkPassphrase: nextConfig.networkPassphrase });
        setRelayerMode(nextRelayerMode);
        setSession(restoredSession);
      } catch (err) {
        if (cancelled) {
          return;
        }
        const detail = err instanceof Error ? err.message : "failed to restore wallet session";
        setError(detail);
      } finally {
        if (!cancelled) {
          setAction("idle");
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    session,
    isConnected,
    isBusy,
    action,
    error,
    address,
    relayerMode,
    networkPassphrase: config.networkPassphrase,
    userName,
    setUserName,
    connect,
    create,
    disconnect,
    clearError,
  };
}
