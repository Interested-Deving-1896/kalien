import {
  IndexedDBStorage,
  SmartAccountKit,
  validateAddress,
  type ConnectWalletResult,
} from "smart-account-kit";
import type { Keypair, Transaction } from "@stellar/stellar-sdk";
import { parseClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";
import {
  DEFAULT_ACCOUNT_WASM_HASH,
  DEFAULT_RPC_URL,
  DEFAULT_RP_NAME,
  DEFAULT_SMART_WALLET_USER_NAME,
  DEFAULT_WEBAUTHN_VERIFIER_ADDRESS,
  SMART_WALLET_APP_NAME,
  TESTNET_NETWORK_PASSPHRASE,
} from "../consts";

export interface SmartWalletSession {
  contractId: string;
  credentialId: string;
}

export interface SmartAccountConfig {
  rpcUrl: string;
  networkPassphrase: string;
  accountWasmHash: string;
  webauthnVerifierAddress: string;
  relayerUrl: string;
  rpName: string;
}

function getEnvValue(key: keyof ImportMetaEnv): string | undefined {
  const value = import.meta.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return undefined;
}

const configuredNetworkPassphrase =
  getEnvValue("VITE_NETWORK_PASSPHRASE") ?? TESTNET_NETWORK_PASSPHRASE;

const config: SmartAccountConfig = {
  rpcUrl: getEnvValue("VITE_RPC_URL") ?? DEFAULT_RPC_URL,
  networkPassphrase: configuredNetworkPassphrase,
  accountWasmHash: getEnvValue("VITE_ACCOUNT_WASM_HASH") ?? DEFAULT_ACCOUNT_WASM_HASH,
  webauthnVerifierAddress:
    getEnvValue("VITE_WEBAUTHN_VERIFIER_ADDRESS") ?? DEFAULT_WEBAUTHN_VERIFIER_ADDRESS,
  relayerUrl: getEnvValue("VITE_RELAYER_PROXY_URL") ?? "/api/relay",
  rpName: getEnvValue("VITE_RP_NAME") ?? DEFAULT_RP_NAME,
};

let kitInstance: SmartAccountKit | null = null;

interface AssembledDeploymentTransaction {
  built?: Transaction;
  signed?: Transaction;
}

type SmartAccountKitPatchTarget = {
  deployerKeypair: Keypair;
  signWithDeployer(tx: AssembledDeploymentTransaction): Promise<void>;
};

export function signBuiltDeploymentTransaction(
  tx: AssembledDeploymentTransaction,
  deployerKeypair: Keypair,
): void {
  if (!tx.built) {
    throw new Error("deployment transaction has not been built");
  }

  // The deploy transaction is already fully assembled at this point. Routing it
  // back through AssembledTransaction.sign() re-clones Soroban fees and breaks
  // Channels relayer submission with FEE_MISMATCH.
  tx.built.sign(deployerKeypair);
  tx.signed = tx.built;
}

function patchSmartAccountKitDeployerSigning(kit: SmartAccountKit): void {
  const internalKit = kit as unknown as SmartAccountKitPatchTarget;
  internalKit.signWithDeployer = async (tx: AssembledDeploymentTransaction) => {
    signBuiltDeploymentTransaction(tx, internalKit.deployerKeypair);
  };
}

function isMissingOnChainContractError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Smart account contract not found on-chain for credential")
  );
}

function ensureClaimantAddress(address: string): string {
  const normalized = address.trim();
  validateAddress(normalized, "claimant address");

  // Accept either classic account (G...) or contract (C...) addresses.
  return parseClaimantStrKeyFromUserInput(normalized).normalized;
}

function toWalletSession(result: ConnectWalletResult): SmartWalletSession {
  return {
    contractId: ensureClaimantAddress(result.contractId),
    credentialId: result.credentialId,
  };
}

export function getSmartAccountConfig(): SmartAccountConfig {
  return { ...config };
}

export function getSmartAccountKit(): SmartAccountKit {
  if (!kitInstance) {
    kitInstance = new SmartAccountKit({
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      accountWasmHash: config.accountWasmHash,
      webauthnVerifierAddress: config.webauthnVerifierAddress,
      storage: new IndexedDBStorage(),
      rpName: config.rpName,
      relayerUrl: config.relayerUrl,
      signatureExpirationLedgers: 2160,
    });
    patchSmartAccountKitDeployerSigning(kitInstance);
  }

  return kitInstance;
}

export async function restoreSmartWalletSession(): Promise<SmartWalletSession | null> {
  const kit = getSmartAccountKit();
  try {
    const result = await kit.connectWallet();
    return result ? toWalletSession(result) : null;
  } catch (error) {
    // smart-account-kit throws when a saved session points at a contract that
    // was never deployed (or no longer exists on the active network).
    if (isMissingOnChainContractError(error)) {
      await kit.disconnect();
      return null;
    }
    throw error;
  }
}

export async function connectSmartWallet(): Promise<SmartWalletSession> {
  const kit = getSmartAccountKit();
  try {
    const result = await kit.connectWallet({ prompt: true });
    if (!result) {
      throw new Error("wallet connection was cancelled");
    }
    return toWalletSession(result);
  } catch (error) {
    if (!isMissingOnChainContractError(error)) {
      throw error;
    }

    // Bypass stale session state and force a fresh passkey-authenticated connect.
    await kit.disconnect();
    const retried = await kit.connectWallet({ prompt: true, fresh: true });
    if (!retried) {
      throw new Error("wallet connection was cancelled", { cause: error });
    }
    return toWalletSession(retried);
  }
}

export async function createSmartWallet(userName: string): Promise<SmartWalletSession> {
  const kit = getSmartAccountKit();
  const normalizedUserName =
    userName.trim().length > 0 ? userName.trim() : DEFAULT_SMART_WALLET_USER_NAME;

  const creation = await kit.createWallet(SMART_WALLET_APP_NAME, normalizedUserName, {
    autoSubmit: true,
    forceMethod: "relayer",
  });

  if (!creation.submitResult?.success) {
    await kit.disconnect();
    throw new Error(creation.submitResult?.error ?? "wallet deployment failed");
  }
  return {
    contractId: ensureClaimantAddress(creation.contractId),
    credentialId: creation.credentialId,
  };
}

export async function disconnectSmartWallet(): Promise<void> {
  await getSmartAccountKit().disconnect();
}

export async function resolveSmartWalletSessionForClaimant(
  claimantAddress: string,
): Promise<SmartWalletSession> {
  const normalizedClaimant = ensureClaimantAddress(claimantAddress);
  const kit = getSmartAccountKit();

  // Try restoring from an existing session. We intentionally omit contractId
  // because the library throws "Could not determine credential ID" when
  // contractId is provided without a matching credentialId in IndexedDB.
  let restored: ConnectWalletResult | null = null;
  try {
    restored = await kit.connectWallet();
  } catch (error) {
    if (isMissingOnChainContractError(error)) {
      await kit.disconnect();
    } else {
      throw error;
    }
  }
  if (restored) {
    const restoredSession = toWalletSession(restored);
    if (restoredSession.contractId === normalizedClaimant) {
      return restoredSession;
    }
  }

  // No matching session; prompt the user to authenticate with their passkey.
  // Use fresh: true to bypass any cached session for a different contract.
  const connected = await kit.connectWallet({ prompt: true, fresh: true });
  if (!connected) {
    throw new Error("wallet connection was cancelled");
  }

  const session = toWalletSession(connected);
  if (session.contractId !== normalizedClaimant) {
    throw new Error("connected wallet does not match requested claimant address");
  }
  return session;
}
