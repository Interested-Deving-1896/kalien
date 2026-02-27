import { Client as ScoreClient, networks as scoreNetworks } from "asteroids-score";

export const SEED_INTERVAL_SECONDS = 600; // 10 minutes

/**
 * Read the current seed by simulating `current_seed()` via the SDK client.
 *
 * Returns `null` when simulation fails (contract unreachable, etc.).
 */
export async function fetchSeedFromContract(
  contractId: string,
  rpcUrl: string,
): Promise<number | null> {
  try {
    const client = new ScoreClient({
      contractId,
      rpcUrl,
      networkPassphrase: scoreNetworks.testnet.networkPassphrase,
    });
    const tx = await client.current_seed();
    return tx.result.seed;
  } catch {
    return null;
  }
}
