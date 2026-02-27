/**
 * Trigger a leaderboard sync via the dev endpoint.
 *
 * Usage:
 *   bun scripts/trigger-sync.ts
 *   bun scripts/trigger-sync.ts --from-ledger 5000000
 *   bun scripts/trigger-sync.ts --reset-cursor
 *
 * Reads DEV_API_KEY from .dev.vars automatically.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars(): Record<string, string> {
  const path = join(__dirname, "../.dev.vars");
  const vars: Record<string, string> = {};
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // ignore missing file
  }
  return vars;
}

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173";
const vars = loadDevVars();
const DEV_API_KEY = process.env.DEV_API_KEY ?? vars.DEV_API_KEY ?? "";

if (!DEV_API_KEY) {
  console.error("Error: DEV_API_KEY not set in .dev.vars or environment");
  process.exit(1);
}

const args = process.argv.slice(2);
const resetCursor = args.includes("--reset-cursor");
const fromLedgerIdx = args.indexOf("--from-ledger");
const fromLedger = fromLedgerIdx !== -1 ? args[fromLedgerIdx + 1] : null;

const params = new URLSearchParams();
if (resetCursor) params.set("reset_cursor", "1");
if (fromLedger) params.set("from_ledger", fromLedger);

const url = `${BASE_URL}/api/leaderboard/dev/sync${params.size > 0 ? `?${params}` : ""}`;
console.log(`POST ${url}`);

const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${DEV_API_KEY}` },
});

const body = await res.json();
console.log(JSON.stringify(body, null, 2));
