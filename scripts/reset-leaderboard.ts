/**
 * Reset the local leaderboard and re-ingest real events from Stellar testnet RPC.
 *
 * Usage: bun scripts/reset-leaderboard.ts
 */

import { fetchLeaderboardEventsFromGalexie } from "../worker/leaderboard-ingestion";
import type { WorkerEnv } from "../worker/env";
import type { LeaderboardEventRecord } from "../worker/types";

const BASE_URL = "http://localhost:5173";
const DEV_API_KEY = process.env.DEV_API_KEY ?? "";
const devAuthHeaders: Record<string, string> = DEV_API_KEY
  ? { Authorization: `Bearer ${DEV_API_KEY}` }
  : {};
const TESTNET_RPC = "https://soroban-testnet.stellar.org/";
const SCORE_CONTRACT = "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";

function makeEnv(): WorkerEnv {
  return {
    SCORE_CONTRACT_ID: SCORE_CONTRACT,
    GALEXIE_RPC_BASE_URL: TESTNET_RPC,
    GALEXIE_SOURCE_MODE: "rpc",
    GALEXIE_REQUEST_TIMEOUT_MS: "30000",
  } as WorkerEnv;
}

async function main() {
  // 1. Reset all leaderboard data
  console.log("Resetting leaderboard data...");
  const resetResponse = await fetch(`${BASE_URL}/dev/api/leaderboard/reset`, {
    method: "POST",
    headers: devAuthHeaders,
  });
  if (!resetResponse.ok) {
    console.error(`Reset failed (${resetResponse.status}): ${await resetResponse.text()}`);
    process.exit(1);
  }
  console.log("Reset:", await resetResponse.json());

  // 2. Get RPC health to find ledger range
  const healthResponse = await fetch(TESTNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });
  const health = (await healthResponse.json()) as {
    result: { oldestLedger: number; latestLedger: number };
  };
  const { oldestLedger, latestLedger } = health.result;
  console.log(`RPC ledger range: ${oldestLedger} - ${latestLedger}`);

  // 3. Scan for real score_submitted events across the retention window
  const env = makeEnv();
  const allEvents: LeaderboardEventRecord[] = [];
  const BATCH_SIZE = 10_000; // ledgers per batch

  console.log(`Scanning for score_submitted events from ledger ${oldestLedger} to ${latestLedger}...`);

  let fromLedger = oldestLedger;
  while (fromLedger < latestLedger) {
    const toLedger = Math.min(fromLedger + BATCH_SIZE, latestLedger);
    try {
      const result = await fetchLeaderboardEventsFromGalexie(env, {
        fromLedger,
        toLedger,
        limit: 1000,
        source: "rpc",
      });
      if (result.events.length > 0) {
        allEvents.push(...result.events);
        console.log(
          `  ledgers ${fromLedger}-${toLedger}: found ${result.events.length} events ` +
            `(total: ${allEvents.length})`,
        );
      }
    } catch (error) {
      // RPC may reject large ranges — shrink and retry
      console.warn(`  ledgers ${fromLedger}-${toLedger}: error (${error}), skipping`);
    }
    fromLedger = toLedger;
  }

  console.log(`\nFound ${allEvents.length} real events total.`);

  if (allEvents.length === 0) {
    console.log("No events found — leaderboard is empty (clean state).");
    return;
  }

  // Deduplicate by eventId
  const uniqueEvents = [...new Map(allEvents.map((e) => [e.eventId, e])).values()];
  console.log(`After dedup: ${uniqueEvents.length} unique events.`);

  // 4. Seed real events into the leaderboard
  console.log("Seeding real events into leaderboard...");
  const seedResponse = await fetch(`${BASE_URL}/dev/api/leaderboard/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...devAuthHeaders },
    body: JSON.stringify({ events: uniqueEvents }),
  });
  if (!seedResponse.ok) {
    console.error(`Seed failed (${seedResponse.status}): ${await seedResponse.text()}`);
    process.exit(1);
  }
  console.log("Seed result:", await seedResponse.json());

  // 5. Verify the leaderboard
  const lbResponse = await fetch(`${BASE_URL}/api/leaderboard?window=all&limit=50`);
  const lb = (await lbResponse.json()) as {
    entries: Array<Record<string, unknown>>;
    pagination: { total: number };
    ingestion: Record<string, unknown>;
  };
  console.log(`\nLeaderboard now has ${lb.pagination.total} players:`);
  for (const entry of lb.entries) {
    const addr = (entry.claimantAddress as string).slice(0, 12) + "...";
    console.log(
      `  #${entry.rank} ${addr} score=${String(entry.score).padStart(7)} ` +
        `seed=0x${((entry.seed as number) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`,
    );
  }
  console.log("\nIngestion:", JSON.stringify(lb.ingestion, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
