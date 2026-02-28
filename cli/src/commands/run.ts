import { cpus } from "os";
import { Autopilot, type AutopilotConfig } from "@/game/Autopilot";
import { renderDashboard, type DashboardStats } from "../display/dashboard";
import * as ansi from "../display/ansi";
import { submitTape, type SubmitResult } from "../api/submit";
import { fetchPlayerScore } from "../api/score";
import type { WorkerToMainMessage } from "../worker/messages";
import { SEED_INTERVAL_SECONDS, MAX_SUBMISSIONS_PER_EPOCH, SETTLE_DELAY_MS } from "../constants";
import { fetchSeedFromContract, fetchBestScoreForSeed } from "@/chain/seed";

const SEED_FETCH_TIMEOUT_MS = 6000;
const SEED_REFRESH_INTERVAL_MS = 4000;

function getCurrentEpoch(): number {
  return Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
}

function epochEndMs(epoch: number): number {
  return (epoch + 1) * SEED_INTERVAL_SECONDS * 1000;
}

export interface RunOptions {
  address: string;
  threads: number;
  max: boolean;
  interval: number; // minutes (minimum time between submissions within an epoch)
  apiUrl: string;
  rpcUrl: string;
  contractId: string;
  relayerBaseUrl: string;
  relayerApiKey: string | null;
}

export async function runCommand(opts: RunOptions): Promise<void> {
  const threadCount = opts.max
    ? cpus().length
    : opts.threads > 0
      ? opts.threads
      : Math.max(1, Math.floor(cpus().length / 2));

  const minSubmitIntervalMs = opts.interval * 60 * 1000;

  // Fetch on-chain high score before starting workers
  process.stdout.write(ansi.color(ansi.cyan, "  Fetching on-chain score..."));
  const playerInfo = await fetchPlayerScore(opts.address, opts.apiUrl);
  let onChainBestScore = playerInfo.bestScore;
  if (onChainBestScore > 0) {
    process.stdout.write(ansi.color(ansi.green, ` ${onChainBestScore}\n`));
  } else {
    process.stdout.write(ansi.color(ansi.dim, " none\n"));
  }

  // Fetch on-chain best for the *current seed_id* so we don't submit worse
  // scores from a previous session or a different client (e.g. the web UI).
  const initialSeedId = getCurrentEpoch();
  process.stdout.write(ansi.color(ansi.cyan, "  Fetching seed best score..."));
  const initialSeedBest = await fetchBestScoreForSeed(
    opts.contractId, opts.rpcUrl, opts.address, initialSeedId,
  );
  if (initialSeedBest > 0) {
    process.stdout.write(ansi.color(ansi.green, ` ${initialSeedBest}\n`));
  } else {
    process.stdout.write(ansi.color(ansi.dim, " none\n"));
  }

  // Epoch tracking
  let currentEpoch = initialSeedId;
  let epochGamesPlayed = 0;
  let currentSeed: number | null = null;
  let seedRefreshInFlight = false;
  let lastSeedRefreshAt = 0;
  let announceSeedResolution = false;

  // Read the currently materialized seed from temporary storage.
  // If the active seed_id has not been materialized yet this returns null.
  async function fetchCurrentSeed(): Promise<number | null> {
    try {
      return await Promise.race<number | null>([
        fetchSeedFromContract(opts.contractId, opts.rpcUrl),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SEED_FETCH_TIMEOUT_MS)),
      ]);
    } catch {
      return null;
    }
  }

  async function refreshCurrentSeed(force = false): Promise<void> {
    if (seedRefreshInFlight) return;

    const now = Date.now();
    if (!force && now - lastSeedRefreshAt < SEED_REFRESH_INTERVAL_MS) {
      return;
    }

    const requestedEpoch = getCurrentEpoch();
    seedRefreshInFlight = true;
    lastSeedRefreshAt = now;
    try {
      const seed = await fetchCurrentSeed();

      // Ignore stale responses that started in a previous epoch.
      if (requestedEpoch !== getCurrentEpoch()) {
        return;
      }

      if (seed !== null) {
        currentSeed = seed;
        if (announceSeedResolution) {
          lastSubmitStatus = ansi.color(
            ansi.cyan,
            `new seed_id materialized (0x${seed.toString(16).padStart(8, "0").toUpperCase()})`,
          );
          announceSeedResolution = false;
        }
      }
    } finally {
      seedRefreshInFlight = false;
    }
  }

  void refreshCurrentSeed(true);

  // Score tracking (per epoch)
  let bestScore = 0;
  let bestTape: Uint8Array | null = null;
  let bestConfig: AutopilotConfig = Autopilot.defaults();
  let lastSubmittedScore = initialSeedBest; // start from on-chain best so we don't submit worse

  // Settle tracking: when a new best is found, record the timestamp.
  // Don't submit until SETTLE_DELAY_MS has elapsed (score may still be climbing).
  let bestScoreFoundAt = 0;

  // Submission budget tracking (per epoch)
  let epochSubmissions = 0;

  // Session stats
  let totalGamesPlayed = 0;
  let totalSubmissions = 0;
  let lastSubmitStatus = "";
  let lastSubmitTime = 0;
  const startTime = Date.now();
  let submitting = false;

  // Per-worker best scores for dashboard display
  const workerBests: number[] = new Array(threadCount).fill(0);

  // Spawn workers: worker 0 is the exploiter, the rest are explorers.
  // Exploiter: small mutations, always tracks the global best.
  // Explorers: large mutations, independent search, restart from random when stuck.
  // String literal URL is required so Bun detects and embeds the worker at compile time.
  const workerUrl = new URL("../worker/game-worker.ts", import.meta.url);
  const workers: Worker[] = [];
  for (let i = 0; i < threadCount; i++) {
    const role = i === 0 ? "exploit" : "explore";
    const worker = new Worker(workerUrl);
    worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case "game-complete":
          totalGamesPlayed++;
          epochGamesPlayed++;
          break;
        case "new-best":
          // Discard tapes from a stale epoch (worker hadn't received reset-best yet)
          if (msg.seedId !== currentEpoch) break;
          if (msg.score > bestScore) {
            bestScore = msg.score;
            bestTape = msg.tape;
            bestConfig = msg.config;
            bestScoreFoundAt = Date.now();

            // Immediately share the new global best with the exploiter (worker 0)
            // so it can start refining this region right away.
            if (msg.workerId !== 0) {
              workers[0]?.postMessage({
                type: "set-config",
                config: msg.config,
                globalScore: msg.score,
              });
            }

            // Also offer to all other explorers — they'll decide whether to adopt
            // based on their own threshold logic (>10% improvement required).
            for (let j = 1; j < workers.length; j++) {
              if (j !== msg.workerId) {
                workers[j]?.postMessage({
                  type: "set-config",
                  config: msg.config,
                  globalScore: msg.score,
                });
              }
            }
          }
          workerBests[msg.workerId] = msg.score;
          break;
        case "stopped":
          break;
      }
    };
    worker.postMessage({ type: "start", workerId: i, role, rpcUrl: opts.rpcUrl, contractId: opts.contractId, relayerBaseUrl: opts.relayerBaseUrl, relayerApiKey: opts.relayerApiKey });
    workers.push(worker);
  }

  function resetEpoch(onChainSeedBest = 0): void {
    const prevBestScore = bestScore;
    const prevBestConfig = bestConfig;

    bestScore = 0;
    bestTape = null;
    lastSubmittedScore = onChainSeedBest; // start from on-chain best so we don't submit worse
    epochGamesPlayed = 0;
    epochSubmissions = 0;
    bestScoreFoundAt = 0;
    workerBests.fill(0);

    // Carry best config forward only if it improved over defaults
    const seedConfig = prevBestScore > 0 ? prevBestConfig : Autopilot.defaults();
    bestConfig = seedConfig;

    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      w.postMessage({ type: "reset-best" });
      if (i === 0) {
        // Exploiter gets the carried-forward best config
        w.postMessage({ type: "set-config", config: seedConfig, globalScore: 0, force: true });
      }
      // Explorers handle their own reset in reset-best (they pick a random config)
    }
  }

  // Submit if we have an unsubmitted improvement
  async function doSubmit(force = false): Promise<void> {
    if (submitting || !bestTape || bestScore <= lastSubmittedScore) return;

    // Check submission budget
    if (epochSubmissions >= MAX_SUBMISSIONS_PER_EPOCH && !force) {
      lastSubmitStatus = ansi.color(ansi.yellow, `budget exhausted (${MAX_SUBMISSIONS_PER_EPOCH}/${MAX_SUBMISSIONS_PER_EPOCH})`);
      return;
    }

    // Settle delay: wait for score to stop climbing before submitting
    if (!force && bestScoreFoundAt > 0 && Date.now() - bestScoreFoundAt < SETTLE_DELAY_MS) {
      return;
    }

    // Respect minimum interval between submissions
    const now = Date.now();
    if (!force && lastSubmitTime > 0 && now - lastSubmitTime < minSubmitIntervalMs) return;

    submitting = true;
    const tape = bestTape;
    const score = bestScore;

    lastSubmitStatus = ansi.color(ansi.yellow, `submitting (score: ${score})...`);

    const result: SubmitResult = await submitTape(tape, opts.address, currentEpoch, opts.apiUrl);

    if (result.success) {
      totalSubmissions++;
      epochSubmissions++;
      lastSubmittedScore = score;
      lastSubmitTime = Date.now();
      lastSubmitStatus = ansi.color(ansi.green, `score ${score} submitted (${result.jobId || "ok"})`);
    } else if (result.rateLimited) {
      lastSubmitStatus = ansi.color(ansi.yellow, `rate limited - will retry`);
    } else {
      lastSubmitStatus = ansi.color(ansi.red, `failed: ${result.error}`);
    }

    submitting = false;
  }

  // Main tick: check epoch transitions and submit improvements
  const tickInterval = setInterval(async () => {
    const epoch = getCurrentEpoch();

    // Epoch changed — new seed_id interval
    if (epoch !== currentEpoch) {
      // Drain loop: during doSubmit(), workers can still post new-best messages
      // that update bestScore/bestTape. Keep submitting until no unsubmitted
      // improvements remain so we never lose a late-arriving high score.
      for (let drain = 0; drain < 10; drain++) {
        while (submitting) await new Promise(r => setTimeout(r, 100));
        if (bestTape && bestScore > lastSubmittedScore) {
          await doSubmit(true);
        } else {
          break;
        }
      }
      currentEpoch = epoch;
      currentSeed = null; // will be updated once the fetch resolves
      resetEpoch(); // reset immediately with 0, then backfill from on-chain
      lastSubmitStatus = ansi.color(ansi.cyan, "new seed_id interval — fetching seed...");
      announceSeedResolution = true;
      // Refresh seed and on-chain score in the background
      void refreshCurrentSeed(true);
      fetchPlayerScore(opts.address, opts.apiUrl).then(info => { onChainBestScore = info.bestScore; });
      // Fetch this player's on-chain best for the new seed so we don't
      // submit scores worse than what's already claimed.
      fetchBestScoreForSeed(opts.contractId, opts.rpcUrl, opts.address, epoch).then(seedBest => {
        // Only apply if we're still in the same epoch and haven't already
        // submitted something better this session.
        if (epoch === currentEpoch && seedBest > lastSubmittedScore) {
          lastSubmittedScore = seedBest;
        }
      });
    }

    // Initial/current epoch seed may not be materialized immediately.
    // Keep polling in the background until it appears so the dashboard can update.
    if (currentSeed === null) {
      void refreshCurrentSeed();
    }

    // Try to submit if we have a settled improvement
    await doSubmit();
  }, 2000);

  // Dashboard update
  process.stdout.write(ansi.clearScreen + ansi.cursorHide);
  const dashInterval = setInterval(() => {
    const now = Date.now();
    const epochRemainingSec = Math.max(0, (epochEndMs(currentEpoch) - now) / 1000);

    // Settle countdown (seconds remaining before we'll submit)
    let settleRemainingSec = 0;
    if (bestScoreFoundAt > 0 && bestScore > lastSubmittedScore) {
      const elapsed = now - bestScoreFoundAt;
      if (elapsed < SETTLE_DELAY_MS) {
        settleRemainingSec = Math.ceil((SETTLE_DELAY_MS - elapsed) / 1000);
      }
    }

    const stats: DashboardStats = {
      totalGamesPlayed,
      epochGamesPlayed,
      bestScore,
      lastSubmittedScore,
      totalSubmissions,
      lastSubmitStatus,
      epochRemainingSec,
      currentSeed,
      threads: threadCount,
      address: opts.address,
      startTime,
      workerBests,
      onChainBestScore,
      epochSubmissions,
      maxSubmissionsPerEpoch: MAX_SUBMISSIONS_PER_EPOCH,
      settleRemainingSec,
    };
    renderDashboard(stats);
  }, 500);

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    clearInterval(dashInterval);
    clearInterval(tickInterval);

    process.stdout.write(ansi.cursorShow);
    console.log("\n");
    console.log(ansi.color(ansi.brightCyan, "  Shutting down..."));

    // Stop workers
    for (const w of workers) {
      w.postMessage({ type: "stop" });
    }

    // Drain any in-flight submit before the final one
    while (submitting) await new Promise(r => setTimeout(r, 100));
    // Final submit if we have an unsubmitted improvement
    if (bestTape && bestScore > lastSubmittedScore) {
      console.log(ansi.color(ansi.yellow, `  Submitting best tape (score: ${bestScore})...`));
      const result = await submitTape(bestTape, opts.address, currentEpoch, opts.apiUrl);
      if (result.success) {
        totalSubmissions++;
        console.log(ansi.color(ansi.green, `  Submitted! Job: ${result.jobId || "ok"}`));
      } else {
        console.log(ansi.color(ansi.red, `  Submit failed: ${result.error}`));
      }
    } else {
      console.log(ansi.color(ansi.dim, "  No unsubmitted improvements."));
    }

    // Summary
    const elapsed = (Date.now() - startTime) / 1000;
    console.log("");
    console.log(ansi.color(ansi.brightWhite, "  Session Summary"));
    console.log(ansi.color(ansi.gray, `  Games: ${totalGamesPlayed}  |  Best: ${bestScore}  |  Submissions: ${totalSubmissions}`));
    console.log(ansi.color(ansi.gray, `  On-chain best: ${onChainBestScore}  |  Duration: ${Math.round(elapsed)}s`));
    console.log("");

    // Terminate workers
    for (const w of workers) {
      w.terminate();
    }

    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown();
  });
  process.on("SIGTERM", () => {
    shutdown();
  });

  // Keep alive
  await new Promise(() => {});
}
