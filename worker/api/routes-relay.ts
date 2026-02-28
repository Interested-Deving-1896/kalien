import { Hono } from "hono";
import { submitRelayProxy, type RelayProxyPayload } from "../claim/direct";
import type { WorkerEnv } from "../env";
import { safeErrorMessage } from "../utils";
import { hasCapacity, recordSubmission, retryAfterSeconds } from "./rate-limit";

const RELAY_SUBMISSION_LIMIT = 20;
const RELAY_SUBMISSION_WINDOW_MS = 60_000;

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

function clientIp(c: { req: { raw: Request } }): string {
  return c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
}

function parseRelayPayload(body: unknown): { payload: RelayProxyPayload } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "request body must be a JSON object" };
  }

  const source = body as Record<string, unknown>;
  const xdrValue = typeof source.xdr === "string" ? source.xdr.trim() : "";
  const funcValue = typeof source.func === "string" ? source.func.trim() : "";
  const hasXdr = xdrValue.length > 0;
  const hasFunc = funcValue.length > 0;

  if (hasXdr && hasFunc) {
    return { error: "provide either xdr or func/auth payload, not both" };
  }

  if (hasXdr) {
    return {
      payload: {
        kind: "xdr",
        xdr: xdrValue,
      },
    };
  }

  if (hasFunc) {
    const authValue = source.auth;
    if (authValue == null) {
      return {
        payload: {
          kind: "soroban",
          func: funcValue,
          auth: [],
        },
      };
    }
    if (!Array.isArray(authValue)) {
      return {
        error: "auth must be an array of base64 strings when func is provided",
      };
    }

    const auth: string[] = [];
    for (let i = 0; i < authValue.length; i += 1) {
      const value = authValue[i];
      if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `auth[${i}] must be a non-empty base64 string` };
      }
      auth.push(value.trim());
    }

    return {
      payload: {
        kind: "soroban",
        func: funcValue,
        auth,
      },
    };
  }

  return { error: "missing payload: provide xdr or func/auth" };
}

export function createRelayRouter(): Hono<{ Bindings: WorkerEnv }> {
  const router = new Hono<{ Bindings: WorkerEnv }>();

  router.post("/", async (c) => {
    const ipKey = `relay:${clientIp(c)}`;
    if (!hasCapacity(ipKey, RELAY_SUBMISSION_LIMIT, RELAY_SUBMISSION_WINDOW_MS)) {
      const retryAfter = retryAfterSeconds(
        ipKey,
        RELAY_SUBMISSION_LIMIT,
        RELAY_SUBMISSION_WINDOW_MS,
      );
      c.header("Retry-After", String(Math.max(1, retryAfter)));
      return jsonError(c, 429, "too many relay submissions; try again later");
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      return jsonError(c, 400, `invalid JSON body: ${safeErrorMessage(error)}`);
    }

    const parsed = parseRelayPayload(body);
    if ("error" in parsed) {
      return jsonError(c, 400, parsed.error);
    }

    recordSubmission(ipKey, RELAY_SUBMISSION_WINDOW_MS);

    const relay = await submitRelayProxy(c.env, parsed.payload);
    if (relay.type === "success") {
      return c.json({
        success: true,
        data: {
          hash: relay.txHash,
          status: "submitted",
        },
      });
    }

    return c.json(
      {
        success: false,
        error: relay.message,
        data: relay.errorDetail ? { detail: relay.errorDetail } : undefined,
      },
      relay.type === "retry" ? 503 : 400,
    );
  });

  return router;
}
