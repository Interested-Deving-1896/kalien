import { cpus } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Autopilot, type AutopilotConfig } from "../../../src/game/Autopilot";
import { renderDashboard, type DashboardStats } from "../display/dashboard";
import * as ansi from "../display/ansi";
import { submitTape, type SubmitResult } from "../api/submit";
import { fetchPlayerScore } from "../api/score";
import type { WorkerToMainMessage } from "../worker/messages";

const EPOCH_SECONDS = 600; // 10-minute seed windows
const MAX_SUBMISSIONS_PER_EPOCH = 10; // Server-side rate limit
const SETTLE_DELAY_MS = 30_000; // Wait 30s after new best before submitting

function getCurrentEpoch(): number {
  return Math.floor(Date.now() / 1000 / EPOCH_SECONDS);
}

function epochEndMs(epoch: number): number {
  return (epoch + 1) * EPOCH_SECONDS * 1000;
}

export interface RunOptions {
  address: string;
  threads: number;
  max: boolean;
  interval: number; // minutes (minimum time between submissions within an epoch)
  apiUrl: string;
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
  const onChainBestScore = playerInfo.bestScore;
  if (onChainBestScore > 0) {
    process.stdout.write(ansi.color(ansi.green, ` ${onChainBestScore}\n`));
  } else {
    process.stdout.write(ansi.color(ansi.dim, " none\n"));
  }

  // Epoch tracking
  let currentEpoch = getCurrentEpoch();
  let epochGamesPlayed = 0;

  // Score tracking (per epoch)
  let bestScore = 0;
  let bestTape: Uint8Array | null = null;
  let bestConfig: AutopilotConfig = Autopilot.defaults();
  let lastSubmittedScore = 0;

  // Settle tracking: when a new best is found, record the timestamp.
  // Don't submit until SETTLE_DELAY_MS has elapsed (score may still be climbing).
  let bestScoreFoundAt = 0;

  // Submission budget tracking (per epoch)
  let epochSubmissions = 0;

  // Variant tracking (per epoch)
  let variantsTested = 0;

  // Session stats
  let totalGamesPlayed = 0;
  let totalSubmissions = 0;
  let lastSubmitStatus = "";
  let lastSubmitTime = 0;
  const startTime = Date.now();
  let submitting = false;

  // Resolve worker path relative to this file
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workerPath = resolve(__dirname, "../worker/game-worker.ts");

  // Spawn workers
  const workers: Worker[] = [];
  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(workerPath);
    worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case "game-complete":
          totalGamesPlayed++;
          epochGamesPlayed++;
          variantsTested++;
          break;
        case "new-best":
          if (msg.score > bestScore) {
            bestScore = msg.score;
            bestTape = msg.tape;
            bestConfig = msg.config;
            bestScoreFoundAt = Date.now();
          }
          break;
        case "stopped":
          break;
      }
    };
    worker.postMessage({ type: "start", workerId: i });
    workers.push(worker);
  }

  function resetEpoch(): void {
    const prevBestScore = bestScore;
    const prevBestConfig = bestConfig;

    bestScore = 0;
    bestTape = null;
    lastSubmittedScore = 0;
    epochGamesPlayed = 0;
    variantsTested = 0;
    epochSubmissions = 0;
    bestScoreFoundAt = 0;

    // Carry best config forward only if it improved over defaults
    const seedConfig = prevBestScore > 0 ? prevBestConfig : Autopilot.defaults();
    bestConfig = seedConfig;

    for (const w of workers) {
      w.postMessage({ type: "reset-best" });
      w.postMessage({ type: "set-config", config: seedConfig });
    }
  }

  // Submit if we have an unsubmitted improvement
  async function doSubmit(force = false): Promise<void> {
    if (submitting || !bestTape || bestScore <= lastSubmittedScore) return;

    // Don't submit scores that won't beat the on-chain best
    // (on-chain best is all-time across seeds, but submitting a lower score
    // for a new seed is fine since per-seed tracking starts at 0)
    // The contract tracks per-(claimant, seed), so this check is just a heuristic
    // to avoid obviously wasteful submissions for the same seed within an epoch.

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

    const result: SubmitResult = await submitTape(tape, opts.address, opts.apiUrl);

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

    // Epoch changed — new seed window
    if (epoch !== currentEpoch) {
      // Force-submit any unsubmitted improvement from the old epoch
      if (bestTape && bestScore > lastSubmittedScore) {
        await doSubmit(true);
      }
      currentEpoch = epoch;
      resetEpoch();
      lastSubmitStatus = ansi.color(ansi.cyan, `new seed epoch (${epoch})`);
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
      epoch: currentEpoch,
      threads: threadCount,
      address: opts.address,
      startTime,
      variantsTested,
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

    // Final submit if we have an unsubmitted improvement
    if (bestTape && bestScore > lastSubmittedScore) {
      console.log(ansi.color(ansi.yellow, `  Submitting best tape (score: ${bestScore})...`));
      const result = await submitTape(bestTape, opts.address, opts.apiUrl);
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
