import { createContext, useContext } from "react";
import { useWallet, type UseWalletReturn } from "@/hooks/useWallet";
import { useTokenBalance, type UseTokenBalanceReturn } from "@/hooks/useTokenBalance";

const WalletStateContext = createContext<UseWalletReturn | null>(null);
const TokenBalanceContext = createContext<UseTokenBalanceReturn | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const balance = useTokenBalance(wallet.address);

  return (
    <WalletStateContext value={wallet}>
      <TokenBalanceContext value={balance}>{children}</TokenBalanceContext>
    </WalletStateContext>
  );
}

export function useWalletState(): UseWalletReturn {
  const wallet = useContext(WalletStateContext);
  if (!wallet) {
    throw new Error("useWalletState must be used inside <WalletProvider>");
  }
  return wallet;
}

export function useBalanceState(): UseTokenBalanceReturn {
  const balance = useContext(TokenBalanceContext);
  if (!balance) {
    throw new Error("useBalanceState must be used inside <WalletProvider>");
  }
  return balance;
}
