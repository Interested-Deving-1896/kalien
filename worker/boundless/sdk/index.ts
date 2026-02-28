/**
 * Boundless SDK — public exports.
 *
 * Usage:
 *   import { BoundlessClient, buildRequestId, boundlessExplorerUrl } from './sdk';
 *
 * The BoundlessClient class wraps all Boundless on-chain and off-chain
 * interactions into a clean, typed interface:
 *
 *   const client = new BoundlessClient(config);
 *   const submitResult = await client.submitRequest(tapeBytes);
 *   const pollResult = await client.poll(requestIdHex, budgetMs);
 *   const url = client.explorerUrl(requestIdBigInt);
 */

export { BoundlessClient, FulfillmentNotFoundError } from "./client";

export {
  // Request ID
  buildRequestId,
  decodeRequestId,
  requestIdToHex,
  parseBoundlessStatusUrl,
  // Explorer
  boundlessExplorerUrl,
  BOUNDLESS_EXPLORER_BASE_URL,
  // Hex / bytes conversion
  hexToUint8Array,
  uint8ArrayToHex,
  uint8ArrayToHex0x,
} from "./utils";

export type {
  BoundlessClientConfig,
  BoundlessFulfillmentData,
  BoundlessProofRequest,
  BoundlessRequirements,
  BoundlessPredicate,
  BoundlessCallback,
  BoundlessInput,
  BoundlessOffer,
} from "./types";
