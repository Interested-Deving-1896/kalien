// Network presets — RPC URL and score contract address per Stellar network.
// contractId is null for networks where the contract hasn't been deployed yet;
// in that case --contract-id must be supplied on the command line.
export const NETWORKS = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
    relayerUrl: "https://channels.openzeppelin.com/testnet",
  },
  mainnet: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://rpc.lightsail.network",
    contractId: null,
    relayerUrl: "https://channels.openzeppelin.com",
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

// Default backend API URL
export const DEFAULT_API_URL = "https://kalien.xyz";

// Re-export the single source of truth for seed interval duration
export { SEED_INTERVAL_SECONDS } from "@/chain/seed";

// Maximum number of tape submissions allowed per seed_id interval (server-side rate limit)
export const MAX_SUBMISSIONS_PER_EPOCH = 10;

// Wait this long after finding a new best score before submitting.
// Gives the score time to stop climbing before we burn a submission slot.
export const SETTLE_DELAY_MS = 30_000;

// Maximum game frames before forcing a game-over (caps runaway games)
export const MAX_FRAMES = 36_000;

// Explorer workers restart from a random config after this many games without
// improvement, breaking out of local maxima.
export const EXPLORER_RESTART_THRESHOLD = 150;
