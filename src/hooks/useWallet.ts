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

  const withWalletAction = useCallback(
    async (
      actionName: Exclude<WalletAction, "idle" | "restoring">,
      fallbackMsg: string,
      perform: (mod: Awaited<ReturnType<typeof loadSmartWalletModule>>) => Promise<void>,
    ) => {
      setAction(actionName);
      setError(null);

      try {
        const walletModule = await loadSmartWalletModule();
        const nextConfig = walletModule.getSmartAccountConfig();
        setConfig({ networkPassphrase: nextConfig.networkPassphrase });
        setRelayerMode(walletModule.getSmartAccountRelayerMode());
        await perform(walletModule);
      } catch (err) {
        const detail = err instanceof Error ? err.message : fallbackMsg;
        setError(detail);
      } finally {
        setAction("idle");
      }
    },
    [],
  );

  const connect = useCallback(
    () =>
      withWalletAction("connecting", "failed to connect wallet", async (mod) => {
        setSession(await mod.connectSmartWallet());
      }),
    [withWalletAction],
  );

  const create = useCallback(
    () =>
      withWalletAction("creating", "failed to create wallet", async (mod) => {
        setSession(await mod.createSmartWallet(userName));
      }),
    [withWalletAction, userName],
  );

  const disconnect = useCallback(
    () =>
      withWalletAction("disconnecting", "failed to disconnect wallet", async (mod) => {
        await mod.disconnectSmartWallet();
        setSession(null);
      }),
    [withWalletAction],
  );

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
