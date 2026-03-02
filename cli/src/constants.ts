// Network presets used by the CLI.
export const NETWORKS = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
    tokenContractId: "CBUCDXT6BY3WWP764AMW66QJA6ZRWL2TRV6VTYCWPZF4FUZRAXK2S253",
    relayerUrl: "https://channels.openzeppelin.com/testnet",
    apiUrl: "https://testnet.kalien.xyz",
  },
  mainnet: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://rpc.lightsail.network",
    contractId: "CDDAYXNY6MMA47Q54VSHG2WV445ZUOJ354NOLSFRC7ZUDTD6OTS4A7PE",
    tokenContractId: "CB4YK5LZG2EGRHJOS4WNX7AAFP3RR3RS5YJUC6D52V2HDT7EQO2QDF6T",
    relayerUrl: "https://channels.openzeppelin.com",
    apiUrl: "https://kalien.xyz",
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

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
