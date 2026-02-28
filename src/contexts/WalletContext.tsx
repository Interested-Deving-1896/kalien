import { createContext, useContext, useMemo } from "react";
import { useWallet, type UseWalletReturn } from "@/hooks/useWallet";
import { useTokenBalance, type UseTokenBalanceReturn } from "@/hooks/useTokenBalance";

interface WalletContextValue {
  wallet: UseWalletReturn;
  balance: UseTokenBalanceReturn;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const balance = useTokenBalance(wallet.address);

  const value = useMemo(() => ({ wallet, balance }), [wallet, balance]);

  return <WalletContext value={value}>{children}</WalletContext>;
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWalletContext must be used inside <WalletProvider>");
  }
  return ctx;
}
