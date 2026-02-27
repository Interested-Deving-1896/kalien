/// <reference types="bun-types" />
import { AsteroidsGame } from "@/game/AsteroidsGame";
import { Autopilot, type AutopilotConfig } from "@/game/Autopilot";
import type { MainToWorkerMessage, WorkerRole, WorkerToMainMessage } from "./messages";
import { mutateConfig, randomConfig } from "./mutate";
import { fetchSeedFromContract } from "@/chain/seed";
import { MAX_FRAMES, EXPLORER_RESTART_THRESHOLD, SEED_INTERVAL_SECONDS } from "../constants";
import { bumpSeedViaRelayer } from "../relayer";

let workerId = 0;
let role: WorkerRole = "explore";
let rpcUrl = "";
let contractId = "";
let relayerBaseUrl = "";
let relayerApiKey: string | null = null;
let running = false;
let bestScore = 0;
let bestConfig: AutopilotConfig = Autopilot.defaults();
let gamesWithoutImprovement = 0;

// Active seed_id cache
let currentSeedId = -1;
let currentSeed: number | null = null;

async function ensureSeed(): Promise<void> {
  const seedId = Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
  if (seedId === currentSeedId && currentSeed !== null) return;

  // A new epoch started. Do not keep using stale epoch seed.
  if (seedId !== currentSeedId) {
    currentSeed = null;
  }

  let fetched: number | null = null;
  let resolvedSeedId: number | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    fetched = await fetchSeedFromContract(contractId, rpcUrl);
    if (fetched !== null) {
      resolvedSeedId = seedId;
      break;
    }
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Seed not yet materialized — worker 0 bumps it via the relayer (if configured),
  // then waits briefly for the chain to confirm before retrying once.
  if (fetched === null && workerId === 0 && relayerApiKey) {
    const bumped = await bumpSeedViaRelayer(
      contractId,
      rpcUrl,
      relayerBaseUrl,
      relayerApiKey,
    );
    if (bumped.success) {
      if (bumped.seed !== null) {
        fetched = bumped.seed;
        resolvedSeedId = bumped.seedId ?? seedId;
      } else {
        await new Promise((r) => setTimeout(r, 3000));
        fetched = await fetchSeedFromContract(contractId, rpcUrl);
        if (fetched !== null) {
          resolvedSeedId = seedId;
        }
      }
    }
  }

  if (fetched !== null) {
    currentSeed = fetched;
    currentSeedId = resolvedSeedId ?? seedId;
  }
  // If still null, keep using the previous seed_id's seed as fallback.
}

function post(msg: WorkerToMainMessage, transfer?: Transferable[]) {
  postMessage(msg, transfer as any);
}

async function runOneGame(): Promise<void> {
  await ensureSeed();
  const seed = currentSeed;
  if (seed === null) {
    if (running) {
      setTimeout(runOneGame, 1000);
    } else {
      post({ type: "stopped", workerId });
    }
    return;
  }

  // Exploit workers: fine-tune with small mutations.
  // Explore workers: broad search with large mutations.
  const scale = role === "exploit" ? 0.5 : 1.5;
  const config = mutateConfig(bestConfig, scale);

  const game = new AsteroidsGame({ headless: true, seed, autopilotConfig: config });
  game.startNewGame(seed);
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  while (frame < MAX_FRAMES) {
    game.stepSimulation();
    frame++;
    if (game.getMode() === "game-over") break;
  }

  const score = game.getScore();

  if (score > bestScore) {
    const tape = game.getTape();
    if (tape) {
      bestScore = score;
      bestConfig = config;
      gamesWithoutImprovement = 0;
      const copy = new Uint8Array(tape);
      post(
        { type: "new-best", workerId, score, frames: frame, tape: copy, config },
        [copy.buffer],
      );
    }
  } else {
    gamesWithoutImprovement++;

    // Explorers: restart from a random config when stuck to escape local maxima
    if (role === "explore" && gamesWithoutImprovement >= EXPLORER_RESTART_THRESHOLD) {
      bestConfig = randomConfig();
      bestScore = 0;
      gamesWithoutImprovement = 0;
    }
  }

  post({ type: "game-complete", workerId, score, frames: frame, workerBest: bestScore });

  // Yield to event loop so messages (stop, reset-best, set-config) can be processed,
  // then start next game
  if (running) {
    setTimeout(runOneGame, 0);
  } else {
    post({ type: "stopped", workerId });
  }
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "start":
      workerId = msg.workerId;
      role = msg.role;
      rpcUrl = msg.rpcUrl;
      contractId = msg.contractId;
      relayerBaseUrl = msg.relayerBaseUrl;
      relayerApiKey = msg.relayerApiKey;
      running = true;
      bestScore = 0;
      gamesWithoutImprovement = 0;
      bestConfig = role === "exploit" ? Autopilot.defaults() : randomConfig();
      void runOneGame();
      break;
    case "stop":
      running = false;
      break;
    case "reset-best":
      bestScore = 0;
      gamesWithoutImprovement = 0;
      // Reset seed cache so the next game fetches the current seed_id's seed.
      currentSeedId = -1;
      currentSeed = null;
      // On epoch reset, explorers restart from a fresh random config so they
      // search different territory from the exploiter.
      if (role === "explore") {
        bestConfig = randomConfig();
      }
      break;
    case "set-config":
      if (msg.force) {
        // Forced update (epoch reset for exploiter): always adopt
        bestConfig = msg.config;
        bestScore = msg.globalScore;
      } else if (role === "exploit") {
        // Exploiter: always follow the global best
        if (msg.globalScore > bestScore) {
          bestConfig = msg.config;
          bestScore = msg.globalScore;
        }
      } else {
        // Explorers: only adopt if the global best is significantly better (>10%)
        // — don't disrupt a productive exploration run for marginal gains
        if (msg.globalScore > bestScore * 1.1) {
          bestConfig = msg.config;
          bestScore = msg.globalScore;
          gamesWithoutImprovement = 0;
        }
      }
      break;
  }
};
