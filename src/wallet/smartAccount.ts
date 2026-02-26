import {
  IndexedDBStorage,
  SmartAccountKit,
  validateAddress,
  type ConnectWalletResult,
} from "smart-account-kit";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels/dist/client";
import { parseClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";
import { formatRelayerError } from "../lib/errors";
import {
  DEFAULT_ACCOUNT_WASM_HASH,
  DEFAULT_RPC_URL,
  DEFAULT_RP_NAME,
  DEFAULT_SMART_WALLET_USER_NAME,
  DEFAULT_WEBAUTHN_VERIFIER_ADDRESS,
  OPENZEPPELIN_CHANNELS_MAINNET_URL,
  OPENZEPPELIN_CHANNELS_TESTNET_URL,
  PUBLIC_NETWORK_PASSPHRASE,
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
  relayerUrl: string | null;
  relayerApiKey: string | null;
  relayerPluginId: string | null;
  rpName: string;
}

export type SmartAccountRelayerMode = "configured" | "disabled";

function getEnvValue(key: keyof ImportMetaEnv): string | undefined {
  const value = import.meta.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return undefined;
}

function defaultChannelsUrlForNetwork(networkPassphrase: string): string {
  if (networkPassphrase === TESTNET_NETWORK_PASSPHRASE) {
    return OPENZEPPELIN_CHANNELS_TESTNET_URL;
  }

  if (networkPassphrase === PUBLIC_NETWORK_PASSPHRASE) {
    return OPENZEPPELIN_CHANNELS_MAINNET_URL;
  }

  return OPENZEPPELIN_CHANNELS_TESTNET_URL;
}

const configuredNetworkPassphrase =
  getEnvValue("VITE_NETWORK_PASSPHRASE") ?? TESTNET_NETWORK_PASSPHRASE;

const config: SmartAccountConfig = {
  rpcUrl: getEnvValue("VITE_RPC_URL") ?? DEFAULT_RPC_URL,
  networkPassphrase: configuredNetworkPassphrase,
  accountWasmHash: getEnvValue("VITE_ACCOUNT_WASM_HASH") ?? DEFAULT_ACCOUNT_WASM_HASH,
  webauthnVerifierAddress:
    getEnvValue("VITE_WEBAUTHN_VERIFIER_ADDRESS") ?? DEFAULT_WEBAUTHN_VERIFIER_ADDRESS,
  relayerUrl:
    getEnvValue("VITE_RELAYER_URL") ?? defaultChannelsUrlForNetwork(configuredNetworkPassphrase),
  relayerApiKey: getEnvValue("VITE_RELAYER_API_KEY") ?? null,
  relayerPluginId: getEnvValue("VITE_RELAYER_PLUGIN_ID") ?? null,
  rpName: getEnvValue("VITE_RP_NAME") ?? DEFAULT_RP_NAME,
};

let kitInstance: SmartAccountKit | null = null;

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

export function getSmartAccountRelayerMode(): SmartAccountRelayerMode {
  if (!config.relayerUrl || !config.relayerApiKey) {
    return "disabled";
  }

  return "configured";
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
      relayerUrl: config.relayerUrl ?? undefined,
    });
  }

  return kitInstance;
}

async function submitDeploymentXdr(signedTransaction: string): Promise<void> {
  const relayerUrl = config.relayerUrl?.trim() ?? "";
  const relayerApiKey = config.relayerApiKey?.trim() ?? "";

  if (relayerUrl.length === 0 || relayerApiKey.length === 0) {
    throw new Error(
      "relayer is required; set VITE_RELAYER_URL and VITE_RELAYER_API_KEY for smart wallet deployment",
    );
  }

  const client = new ChannelsClient({
    baseUrl: relayerUrl,
    apiKey: relayerApiKey,
    pluginId: config.relayerPluginId ?? undefined,
  });
  try {
    await client.submitTransaction({ xdr: signedTransaction });
  } catch (error) {
    throw new Error(`relayer submission failed: ${formatRelayerError(error)}`, { cause: error });
  }
}

export async function restoreSmartWalletSession(): Promise<SmartWalletSession | null> {
  const result = await getSmartAccountKit().connectWallet();
  return result ? toWalletSession(result) : null;
}

export async function connectSmartWallet(): Promise<SmartWalletSession> {
  const result = await getSmartAccountKit().connectWallet({ prompt: true });
  if (!result) {
    throw new Error("wallet connection was cancelled");
  }

  return toWalletSession(result);
}

export async function createSmartWallet(userName: string): Promise<SmartWalletSession> {
  const kit = getSmartAccountKit();
  const normalizedUserName =
    userName.trim().length > 0 ? userName.trim() : DEFAULT_SMART_WALLET_USER_NAME;

  const creation = await kit.createWallet(SMART_WALLET_APP_NAME, normalizedUserName, {
    autoSubmit: false,
  });

  try {
    await submitDeploymentXdr(creation.signedTransaction);
  } catch (error) {
    await kit.disconnect();
    throw error;
  }

  const connected = await kit.connectWallet({
    contractId: creation.contractId,
    credentialId: creation.credentialId,
  });
  if (!connected) {
    throw new Error("wallet deployed, but failed to restore connected session");
  }

  return toWalletSession(connected);
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
  const restored = await kit.connectWallet();
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
