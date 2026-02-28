import { Hono } from "hono";
import type { WorkerEnv } from "../env";
import { createHealthRouter } from "./routes-health";
import { createProofsRouter } from "./routes-proofs";
import { createRelayRouter } from "./routes-relay";
import { createSeedRouter } from "./routes-seed";

function jsonError(
  c: { json: (body: unknown, status?: number) => Response },
  status: number,
  error: string,
): Response {
  return c.json(
    {
      success: false,
      error,
    },
    status,
  );
}

export function createApiRouter(): Hono<{ Bindings: WorkerEnv }> {
  const api = new Hono<{ Bindings: WorkerEnv }>();

  api.route("/health", createHealthRouter());
  api.route("/seed", createSeedRouter());
  api.route("/relay", createRelayRouter());
  api.route("/proofs", createProofsRouter());

  api.notFound((c) => {
    return jsonError(c, 404, `unknown api route: ${c.req.path}`);
  });

  return api;
}
