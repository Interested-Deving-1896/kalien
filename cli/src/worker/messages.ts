import type { AutopilotConfig } from "../../../src/game/Autopilot";

/** Messages from main thread -> worker */
export type MainToWorkerMessage =
  | { type: "start"; workerId: number }
  | { type: "stop" }
  | { type: "reset-best" }
  | { type: "set-config"; config: AutopilotConfig };

/** Messages from worker -> main thread */
export type WorkerToMainMessage =
  | { type: "game-complete"; workerId: number; score: number; frames: number }
  | { type: "new-best"; workerId: number; score: number; frames: number; tape: Uint8Array; config: AutopilotConfig }
  | { type: "stopped"; workerId: number };
