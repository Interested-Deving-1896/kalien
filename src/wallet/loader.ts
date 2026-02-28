type SmartWalletModule = typeof import("./smartAccount");

let smartWalletModulePromise: Promise<SmartWalletModule> | null = null;

export async function loadSmartWalletModule(): Promise<SmartWalletModule> {
  if (!smartWalletModulePromise) {
    smartWalletModulePromise = import("./smartAccount");
  }
  return smartWalletModulePromise;
}
