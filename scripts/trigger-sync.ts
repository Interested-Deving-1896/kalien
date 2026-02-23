/**
 * Trigger a leaderboard sync against the real Stellar testnet RPC.
 *
 * Usage: bun scripts/trigger-sync.ts
 */

const BASE_URL = "http://localhost:5173";

async function main() {
  // First check current leaderboard state
  const lbResponse = await fetch(`${BASE_URL}/api/leaderboard?window=all&limit=5`);
  const lb = (await lbResponse.json()) as Record<string, unknown>;
  const ingestion = lb.ingestion as Record<string, unknown>;
  console.log("Current ingestion state:", JSON.stringify(ingestion, null, 2));

  // Trigger sync via the dev/seed endpoint — but we need a proper sync endpoint
  // Since there's no admin sync endpoint exposed, let's call the cron handler
  // via the __scheduled endpoint with proper routing

  // Try calling the worker's scheduled handler through Vite's proxy
  // The Cloudflare Vite plugin should forward __scheduled to the worker
  const scheduledResponse = await fetch(`${BASE_URL}/cdn-cgi/mf/scheduled`, {
    method: "POST",
  });
  console.log("Scheduled response:", scheduledResponse.status, await scheduledResponse.text());
}

main().catch(console.error);
