import { createContext, useContext } from "react";
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

  return <WalletContext value={{ wallet, balance }}>{children}</WalletContext>;
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWalletContext must be used inside <WalletProvider>");
  }
  return ctx;
}
