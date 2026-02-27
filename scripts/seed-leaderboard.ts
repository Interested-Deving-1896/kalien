/**
 * Seed the local leaderboard with diverse test data.
 *
 * Usage: bun scripts/seed-leaderboard.ts
 */

const BASE_URL = "http://localhost:5173";
const DEV_API_KEY = process.env.DEV_API_KEY ?? "";
const devAuthHeaders: Record<string, string> = DEV_API_KEY
  ? { Authorization: `Bearer ${DEV_API_KEY}` }
  : {};

// Generate realistic-looking Stellar addresses
function fakeGAddress(index: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let addr = "G";
  // Deterministic pseudo-random from index
  let h = index * 2654435761;
  for (let i = 0; i < 55; i++) {
    h = ((h >>> 0) * 31 + i * 17) >>> 0;
    addr += chars[h % chars.length];
  }
  return addr;
}

function fakeCAddress(index: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let addr = "C";
  let h = (index + 100) * 2654435761;
  for (let i = 0; i < 55; i++) {
    h = ((h >>> 0) * 31 + i * 13) >>> 0;
    addr += chars[h % chars.length];
  }
  return addr;
}

function fakeTxHash(): string {
  const hex = "0123456789abcdef";
  let hash = "";
  for (let i = 0; i < 64; i++) {
    hash += hex[Math.floor(Math.random() * 16)];
  }
  return hash;
}

interface SeedEvent {
  eventId: string;
  claimantAddress: string;
  seed: number;
  frameCount: number;
  finalScore: number;
  previousBest: number;
  newBest: number;
  mintedDelta: number;
  txHash: string;
  eventIndex: number;
  ledger: number;
  closedAt: string;
  source: "rpc";
  ingestedAt: string;
}

interface SeedProfile {
  claimantAddress: string;
  username: string;
  linkUrl: string | null;
}


const PLAYER_NAMES = [
  "AsteroidAce",
  "ZK_Pioneer",
  "CryptoBlaster",
  "StellarPilot",
  "ProofHunter",
  "NovaShooter",
  "SpaceHasher",
  "QuantumDodge",
  "StarWeaver",
  "NebulaDrift",
  "CosmicProver",
  "OrbitKing",
  "VoidRunner",
  "GalacticZK",
  "MoonRaker42",
];

const LINK_URLS = [
  "https://twitter.com/asteroidace",
  "https://github.com/zkpioneer",
  "https://example.com/player",
  null,
  null,
  "https://stellar.expert/explorer",
  null,
  null,
  "https://kalepail.com",
  null,
  null,
  "https://zerotrustvault.xyz",
  null,
  null,
  null,
];

const SEEDS = [
  0xdeadbeef, 0xcafebabe, 0x12345678, 0xaabbccdd, 0x99887766, 0x11223344, 0xfeedface, 0x0badc0de,
];

function generateEvents(): { events: SeedEvent[]; profiles: SeedProfile[] } {
  const events: SeedEvent[] = [];
  const profiles: SeedProfile[] = [];
  const now = Date.now();

  // 15 players, mix of G and C addresses
  const players: { address: string; name: string; linkUrl: string | null }[] = [];
  for (let i = 0; i < 15; i++) {
    const address = i < 5 ? fakeCAddress(i) : fakeGAddress(i);
    players.push({
      address,
      name: PLAYER_NAMES[i],
      linkUrl: LINK_URLS[i],
    });
    profiles.push({
      claimantAddress: address,
      username: PLAYER_NAMES[i],
      linkUrl: LINK_URLS[i],
    });
  }

  let ledger = 1_000_000;
  let eventIndex = 0;

  // Create events across different time windows:
  // - Some within last 10 minutes (for 10m window)
  // - Some within last 24 hours (for day window)
  // - Some older (for all-time only)

  // --- OLD events (2-7 days ago) ---
  for (let i = 0; i < 15; i++) {
    const player = players[i];
    const daysAgo = 2 + Math.floor(Math.random() * 5);
    const closedAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000 - Math.random() * 3600000);
    const seed = SEEDS[i % SEEDS.length];
    const score = 5000 + Math.floor(Math.random() * 20000);
    const frameCount = 1800 + Math.floor(Math.random() * 5000);

    events.push({
      eventId: `old-${i}-${crypto.randomUUID().slice(0, 8)}`,
      claimantAddress: player.address,
      seed,
      frameCount,
      finalScore: score,
      previousBest: 0,
      newBest: score,
      mintedDelta: score,
      txHash: fakeTxHash(),
      eventIndex: eventIndex++,
      ledger: ledger++,
      closedAt: closedAt.toISOString(),
      source: "rpc",
      ingestedAt: closedAt.toISOString(),
    });
  }

  // --- YESTERDAY events (5-23 hours ago) - improvement runs ---
  for (let i = 0; i < 12; i++) {
    const player = players[i];
    const hoursAgo = 5 + Math.floor(Math.random() * 18);
    const closedAt = new Date(now - hoursAgo * 60 * 60 * 1000);
    const seed = SEEDS[(i + 2) % SEEDS.length];
    const previousBest = events.find(
      (e) => e.claimantAddress === player.address && e.seed === seed,
    )?.newBest ?? 0;
    const score = previousBest + 3000 + Math.floor(Math.random() * 30000);
    const frameCount = 2500 + Math.floor(Math.random() * 8000);
    const mintedDelta = score - previousBest;

    events.push({
      eventId: `day-${i}-${crypto.randomUUID().slice(0, 8)}`,
      claimantAddress: player.address,
      seed,
      frameCount,
      finalScore: score,
      previousBest,
      newBest: score,
      mintedDelta,
      txHash: fakeTxHash(),
      eventIndex: eventIndex++,
      ledger: ledger++,
      closedAt: closedAt.toISOString(),
      source: "rpc",
      ingestedAt: closedAt.toISOString(),
    });
  }

  // --- RECENT events (1-9 minutes ago) - some hot activity ---
  for (let i = 0; i < 8; i++) {
    const player = players[i % players.length];
    const minutesAgo = 1 + Math.floor(Math.random() * 8);
    const closedAt = new Date(now - minutesAgo * 60 * 1000);
    const seed = SEEDS[(i + 4) % SEEDS.length];
    const previousBest = events
      .filter((e) => e.claimantAddress === player.address && e.seed === seed)
      .reduce((max, e) => Math.max(max, e.newBest), 0);
    const score = Math.max(previousBest + 1000, 15000 + Math.floor(Math.random() * 50000));
    const frameCount = 3000 + Math.floor(Math.random() * 10000);
    const mintedDelta = score - previousBest;

    events.push({
      eventId: `recent-${i}-${crypto.randomUUID().slice(0, 8)}`,
      claimantAddress: player.address,
      seed,
      frameCount,
      finalScore: score,
      previousBest,
      newBest: score,
      mintedDelta,
      txHash: fakeTxHash(),
      eventIndex: eventIndex++,
      ledger: ledger++,
      closedAt: closedAt.toISOString(),
      source: "rpc",
      ingestedAt: closedAt.toISOString(),
    });
  }

  // --- Add some multi-run players (same player, same seed, improving scores) ---
  const multiRunPlayer = players[0];
  const multiRunSeed = SEEDS[0];
  let runningBest = events
    .filter((e) => e.claimantAddress === multiRunPlayer.address && e.seed === multiRunSeed)
    .reduce((max, e) => Math.max(max, e.newBest), 0);

  for (let r = 0; r < 5; r++) {
    const hoursAgo = 1 + r * 3;
    const closedAt = new Date(now - hoursAgo * 60 * 60 * 1000);
    const improvement = 5000 + Math.floor(Math.random() * 10000);
    const newScore = runningBest + improvement;
    const frameCount = 4000 + Math.floor(Math.random() * 6000);

    events.push({
      eventId: `multi-${r}-${crypto.randomUUID().slice(0, 8)}`,
      claimantAddress: multiRunPlayer.address,
      seed: multiRunSeed,
      frameCount,
      finalScore: newScore,
      previousBest: runningBest,
      newBest: newScore,
      mintedDelta: improvement,
      txHash: fakeTxHash(),
      eventIndex: eventIndex++,
      ledger: ledger++,
      closedAt: closedAt.toISOString(),
      source: "rpc",
      ingestedAt: closedAt.toISOString(),
    });

    runningBest = newScore;
  }

  // --- Add a high-score champion ---
  const champion = players[2];
  const championClosedAt = new Date(now - 3 * 60 * 1000); // 3 minutes ago
  const championScore = 150_000;
  events.push({
    eventId: `champion-${crypto.randomUUID().slice(0, 8)}`,
    claimantAddress: champion.address,
    seed: SEEDS[3],
    frameCount: 12_000,
    finalScore: championScore,
    previousBest: 0,
    newBest: championScore,
    mintedDelta: championScore,
    txHash: fakeTxHash(),
    eventIndex: eventIndex++,
    ledger: ledger++,
    closedAt: championClosedAt.toISOString(),
    source: "rpc",
    ingestedAt: championClosedAt.toISOString(),
  });

  return { events, profiles };
}

async function main() {
  const { events, profiles } = generateEvents();

  console.log(`Seeding ${events.length} events across ${profiles.length} players...`);
  console.log(
    `  Time distribution: ${events.filter((e) => Date.now() - new Date(e.closedAt).getTime() < 10 * 60 * 1000).length} recent (10m), ` +
      `${events.filter((e) => { const age = Date.now() - new Date(e.closedAt).getTime(); return age >= 10 * 60 * 1000 && age < 24 * 60 * 60 * 1000; }).length} day, ` +
      `${events.filter((e) => Date.now() - new Date(e.closedAt).getTime() >= 24 * 60 * 60 * 1000).length} older`,
  );

  const response = await fetch(`${BASE_URL}/api/leaderboard/dev/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...devAuthHeaders },
    body: JSON.stringify({ events, profiles }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Seed failed (${response.status}): ${text}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log("Seed result:", JSON.stringify(result, null, 2));

  // Verify: fetch the leaderboard for each window
  for (const window of ["10m", "day", "all"] as const) {
    const lbResponse = await fetch(
      `${BASE_URL}/api/leaderboard?window=${window}&limit=10`,
    );
    const lb = (await lbResponse.json()) as Record<string, unknown>;
    const entries = lb.entries as Array<Record<string, unknown>>;
    const pagination = lb.pagination as { total: number };
    console.log(
      `\n[${window}] ${pagination.total} players ranked, showing top ${entries.length}:`,
    );
    for (const entry of entries) {
      const profile = entry.profile as { username?: string } | null;
      const name = profile?.username || (entry.claimantAddress as string).slice(0, 12) + "...";
      console.log(
        `  #${entry.rank} ${name.padEnd(16)} score=${String(entry.score).padStart(7)} frames=${String(entry.frameCount ?? "n/a").padStart(6)} minted=${String(entry.mintedDelta).padStart(7)} seed=0x${((entry.seed as number) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`,
      );
    }
  }

  // Verify player detail for the first player
  const firstPlayer = profiles[0];
  const playerResponse = await fetch(
    `${BASE_URL}/api/leaderboard/player/${firstPlayer.claimantAddress}`,
  );
  const playerResult = (await playerResponse.json()) as { player: Record<string, unknown> };
  const stats = playerResult.player.stats as Record<string, unknown>;
  const ranks = playerResult.player.ranks as Record<string, unknown>;
  console.log(`\nPlayer detail for ${firstPlayer.username}:`);
  console.log(
    `  Total runs: ${stats.total_runs}, Best score: ${stats.best_score}, Total minted: ${stats.total_minted}`,
  );
  console.log(
    `  Ranks: 10m=${ranks.ten_min ?? "n/a"}, 24h=${ranks.day ?? "n/a"}, all=${ranks.all ?? "n/a"}`,
  );
  const recentRuns = playerResult.player.recent_runs as Array<Record<string, unknown>>;
  console.log(`  Recent runs: ${recentRuns.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
