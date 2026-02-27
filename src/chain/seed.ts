import { rpc, xdr } from "@stellar/stellar-sdk";

export const SEED_INTERVAL_SECONDS = 600; // 10 minutes

function getCurrentSeedId(): number {
  return Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
}

async function fetchSeedById(
  contractId: string,
  rpcUrl: string,
  seedId: number,
): Promise<number | null> {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http:") });
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("SeedById"), xdr.ScVal.scvU32(seedId)]);

  try {
    const entry = await server.getContractData(contractId, key, rpc.Durability.Temporary);
    const value = entry.val.contractData().val();
    if (value.switch().name !== "scvU32") {
      return null;
    }
    return value.u32() >>> 0;
  } catch {
    return null;
  }
}

/**
 * Read the current seed for the active `seed_id` interval from temporary contract storage.
 *
 * Seeds are stored under DataKey::SeedById(seed_id) in temporary storage.
 *
 * Returns `null` when no seed has been materialized for the active `seed_id`.
 */
export async function fetchSeedFromContract(
  contractId: string,
  rpcUrl: string,
): Promise<number | null> {
  const seedId = getCurrentSeedId();
  return fetchSeedById(contractId, rpcUrl, seedId);
}
