/// <reference types="bun-types" />
import { AsteroidsGame } from "../../../src/game/AsteroidsGame";
import { Autopilot, type AutopilotConfig } from "../../../src/game/Autopilot";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./messages";
import { mutateConfig } from "./mutate";

const MAX_FRAMES = 36_000;

let workerId = 0;
let running = false;
let bestScore = 0;
let bestConfig: AutopilotConfig = Autopilot.defaults();

function post(msg: WorkerToMainMessage, transfer?: Transferable[]) {
  postMessage(msg, transfer as any);
}

function runOneGame(): void {
  const seed = Math.floor(Date.now() / 1000 / 600);
  const config = mutateConfig(bestConfig);
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

  post({ type: "game-complete", workerId, score, frames: frame });

  if (score > bestScore) {
    const tape = game.getTape();
    if (tape) {
      bestScore = score;
      bestConfig = config;
      const copy = new Uint8Array(tape);
      post(
        { type: "new-best", workerId, score, frames: frame, tape: copy, config },
        [copy.buffer],
      );
    }
  }

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
      running = true;
      bestScore = 0;
      bestConfig = Autopilot.defaults();
      runOneGame();
      break;
    case "stop":
      running = false;
      break;
    case "reset-best":
      bestScore = 0;
      break;
    case "set-config":
      bestConfig = msg.config;
      break;
  }
};
