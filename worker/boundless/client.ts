/**
 * Boundless client — backward-compatible wrapper around BoundlessClient SDK.
 *
 * These functions maintain the same signatures as before so that existing
 * callers (coordinator.ts, queue consumer) do not need to change.
 *
 * Internally, they delegate to the BoundlessClient class in ./sdk/client.ts.
 */

import { type BoundlessConfig } from "./config";
import { BoundlessClient } from "./sdk/client";
import type { ProverPollResult, ProverSubmitResult } from "../types";

/**
 * Convert a BoundlessConfig (from worker/boundless/config.ts) into the
 * BoundlessClientConfig format expected by the SDK.
 *
 * They are structurally identical — this is just a pass-through cast.
 */
function toSdkConfig(config: BoundlessConfig) {
  return config;
}

/**
 * Submit a tape to Boundless for proving.
 *
 * @deprecated Use `new BoundlessClient(config).submitRequest(tapeBytes)` directly.
 */
export async function submitToBoundless(
  config: BoundlessConfig,
  tapeBytes: Uint8Array,
): Promise<ProverSubmitResult> {
  const client = new BoundlessClient(toSdkConfig(config));
  return client.submitRequest(tapeBytes);
}

/**
 * Single poll check for Boundless fulfillment.
 *
 * @deprecated Use `new BoundlessClient(config).pollOnce(requestIdHex)` directly.
 */
export async function pollBoundlessOnce(
  config: BoundlessConfig,
  requestIdHex: string,
): Promise<ProverPollResult> {
  const client = new BoundlessClient(toSdkConfig(config));
  return client.pollOnce(requestIdHex);
}

/**
 * Polling loop for Boundless fulfillment, with budget/timeout.
 *
 * @deprecated Use `new BoundlessClient(config).poll(requestIdHex, budgetMs)` directly.
 */
export async function pollBoundless(
  config: BoundlessConfig,
  requestIdHex: string,
  budgetMs: number,
): Promise<ProverPollResult> {
  const client = new BoundlessClient(toSdkConfig(config));
  return client.poll(requestIdHex, budgetMs);
}
