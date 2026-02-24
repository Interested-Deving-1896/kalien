import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { safeErrorMessage, sleep } from "../utils";
import {
  MAX_INLINE_STDIN_BYTES,
  type BoundlessConfig,
} from "./config";
import { boundlessMarketAbi, eip712Types } from "./abi";
import { encodeStdin } from "./stdin";
import { uploadInput } from "./storage";
import type { ProverPollResult, ProverSubmitResult } from "../types";
import type { FulfillmentData, ProofRequest } from "./types";
import { adaptFulfillmentToProverResponse } from "./adapter";

/**
 * Submit a tape to Boundless for proving.
 */
export async function submitToBoundless(
  config: BoundlessConfig,
  tapeBytes: Uint8Array,
): Promise<ProverSubmitResult> {
  const account = privateKeyToAccount(config.privateKey);

  // 1. Encode stdin
  const stdinBytes = encodeStdin(tapeBytes);

  // 2. Determine input type: upload to IPFS if too large for inline, or if IPFS is available
  let inputType: number;
  let inputData: Hex;

  if (stdinBytes.length > MAX_INLINE_STDIN_BYTES) {
    // Must upload to IPFS — inline data would be rejected by the order stream
    if (!config.pinataJwt) {
      return {
        type: "fatal",
        message: `stdin is ${stdinBytes.length} bytes (exceeds ${MAX_INLINE_STDIN_BYTES} inline limit) but PINATA_JWT is not configured`,
      };
    }

    try {
      const stdinUrl = await uploadInput(config.pinataJwt, stdinBytes);
      const urlBytes = new TextEncoder().encode(stdinUrl);
      inputData = `0x${uint8ArrayToHex(new Uint8Array(urlBytes))}` as Hex;
      inputType = 1; // Url
      console.log("[boundless] uploaded stdin to IPFS", { url: stdinUrl, stdinBytes: stdinBytes.length });
    } catch (error) {
      return {
        type: "retry",
        message: `failed uploading stdin to IPFS: ${safeErrorMessage(error)}`,
      };
    }
  } else {
    // Small enough for inline
    inputData = `0x${uint8ArrayToHex(stdinBytes)}` as Hex;
    inputType = 0; // Inline
  }

  // 3. Build the ProofRequest with a reverse Dutch auction
  const nonce = Date.now();
  // requestId = (uint160(addr) << 32) | uint32(nonce) — truncation is intentional
  const requestId = (BigInt(account.address) << 32n) | BigInt(nonce >>> 0);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rampUpStart = nowSec + BigInt(config.flatPeriodSec);

  const proofRequest: ProofRequest = {
    id: requestId,
    requirements: {
      callback: {
        addr: "0x0000000000000000000000000000000000000000",
        gasLimit: 0n,
      },
      predicate: {
        predicateType: 1, // PrefixMatch — match any journal from this image
        data: config.imageId,
      },
      selector: "0x00000000",
    },
    imageUrl: config.imageUrl,
    input: {
      inputType,
      data: inputData,
    },
    offer: {
      minPrice: 0n,                             // Start at zero — reverse Dutch auction
      maxPrice: config.maxPrice,                 // Ceiling the ramp reaches
      rampUpStart,                               // Flat period before ramp begins
      rampUpPeriod: config.rampPeriodSec,        // Seconds for 0 → maxPrice
      lockTimeout: config.lockTimeoutSec,        // Prover deadline (from rampUpStart)
      timeout: config.timeoutSec,                  // Request expiry (from rampUpStart)
      lockCollateral: 0n,
    },
  };

  // Build a viem chain config from chainId + rpcUrl
  const chain = defineChain({
    id: Number(config.chainId),
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const domain = {
    name: "IBoundlessMarket" as const,
    version: "1" as const,
    chainId: config.chainId,
    verifyingContract: config.marketAddress,
  };

  // 4. Sign the request with EIP-712
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });

  let signature: Hex;
  try {
    signature = await walletClient.signTypedData({
      domain,
      types: eip712Types,
      primaryType: "ProofRequest",
      message: proofRequest,
    });
  } catch (error) {
    return {
      type: "retry",
      message: `failed signing proof request: ${safeErrorMessage(error)}`,
    };
  }

  // 5. Submit on-chain
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: config.marketAddress,
      abi: boundlessMarketAbi,
      functionName: "submitRequest",
      args: [proofRequest, signature],
      value: config.maxPrice,
    });
  } catch (error) {
    const msg = safeErrorMessage(error);
    const retryable =
      msg.includes("nonce") ||
      msg.includes("timeout") ||
      msg.includes("429") ||
      msg.includes("502") ||
      msg.includes("503");
    return {
      type: retryable ? "retry" : "fatal",
      message: `failed submitting proof request on-chain: ${msg}`,
    };
  }

  const requestIdHex = `0x${requestId.toString(16)}`;
  console.log("[boundless] submitted proof request on-chain", {
    requestId: requestIdHex,
    txHash,
    stdinBytes: stdinBytes.length,
    inputType: inputType === 1 ? "url" : "inline",
    maxPrice: config.maxPrice.toString(),
    chainId: config.chainId.toString(),
  });

  // 6. Also submit to the off-chain order stream so provers discover it faster.
  //    This is best-effort — the on-chain submission is the source of truth.
  try {
    await submitToOrderStream(config, proofRequest, signature, domain);
    console.log("[boundless] submitted to order stream");
  } catch (error) {
    console.log("[boundless] order stream submission failed (non-fatal):", safeErrorMessage(error));
  }

  return {
    type: "success",
    jobId: requestIdHex,
    statusUrl: `boundless:${requestIdHex}`,
    segmentLimitPo2: 0,
  };
}

const PREDICATE_TYPE_NAMES: Record<number, string> = { 0: "DigestMatch", 1: "PrefixMatch", 2: "ClaimDigestMatch" };
const INPUT_TYPE_NAMES: Record<number, string> = { 0: "Inline", 1: "Url" };

/**
 * Submit the signed order to the off-chain order stream so provers discover it.
 * The order stream uses a JSON format with string enums and split signature fields.
 */
async function submitToOrderStream(
  config: BoundlessConfig,
  request: ProofRequest,
  signature: Hex,
  domain: { name: string; version: string; chainId: bigint; verifyingContract: `0x${string}` },
): Promise<void> {
  const requestDigest = hashTypedData({
    domain,
    types: eip712Types,
    primaryType: "ProofRequest",
    message: request,
  });

  // Parse the 65-byte compact signature into r, s, v
  const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
  const r = `0x${sigClean.slice(0, 64)}`;
  const s = `0x${sigClean.slice(64, 128)}`;
  const v = Number.parseInt(sigClean.slice(128, 130), 16);
  const yParity = v >= 27 ? v - 27 : v;

  const orderBody = {
    request: {
      id: `0x${request.id.toString(16)}`,
      requirements: {
        callback: {
          addr: request.requirements.callback.addr,
          gasLimit: `0x${request.requirements.callback.gasLimit.toString(16)}`,
        },
        predicate: {
          predicateType: PREDICATE_TYPE_NAMES[request.requirements.predicate.predicateType] ?? "DigestMatch",
          data: request.requirements.predicate.data,
        },
        selector: request.requirements.selector,
      },
      imageUrl: request.imageUrl,
      input: {
        inputType: INPUT_TYPE_NAMES[request.input.inputType] ?? "Inline",
        data: request.input.data,
      },
      offer: {
        minPrice: `0x${request.offer.minPrice.toString(16)}`,
        maxPrice: `0x${request.offer.maxPrice.toString(16)}`,
        rampUpStart: Number(request.offer.rampUpStart),
        rampUpPeriod: request.offer.rampUpPeriod,
        lockTimeout: request.offer.lockTimeout,
        timeout: request.offer.timeout,
        lockCollateral: `0x${request.offer.lockCollateral.toString(16)}`,
      },
    },
    request_digest: requestDigest,
    signature: {
      r,
      s,
      yParity: `0x${yParity.toString(16)}`,
      v: `0x${yParity.toString(16)}`,
    },
  };

  const resp = await fetch(`${config.orderStreamUrl}/api/v1/submit_order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderBody),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`order stream returned ${resp.status}: ${body}`);
  }
}

/**
 * Single poll check for Boundless fulfillment.
 */
export async function pollBoundlessOnce(
  config: BoundlessConfig,
  requestIdHex: string,
): Promise<ProverPollResult> {
  const requestId = BigInt(requestIdHex);

  const chain = defineChain({
    id: Number(config.chainId),
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  // 1. Check if fulfilled
  let fulfilled: boolean;
  try {
    fulfilled = await publicClient.readContract({
      address: config.marketAddress,
      abi: boundlessMarketAbi,
      functionName: "requestIsFulfilled",
      args: [requestId],
    });
  } catch (error) {
    return {
      type: "retry",
      message: `failed checking fulfillment status: ${safeErrorMessage(error)}`,
    };
  }

  if (!fulfilled) {
    return {
      type: "running",
      status: "running",
    };
  }

  // 2. Get the fulfillment event logs
  let fulfillmentData: FulfillmentData;
  try {
    const currentBlock = await publicClient.getBlockNumber();
    // Search the last ~24 hours of blocks (Base ~2s/block ≈ 43200, Eth ~12s ≈ 7200).
    // Use a generous window to avoid missing events on fast chains.
    const LOG_SEARCH_WINDOW = 50_000n;
    const fromBlock = config.deploymentBlock > currentBlock - LOG_SEARCH_WINDOW
      ? config.deploymentBlock
      : currentBlock - LOG_SEARCH_WINDOW;

    const logs = await publicClient.getLogs({
      address: config.marketAddress,
      event: {
        type: "event",
        name: "RequestFulfilled",
        inputs: [
          { name: "id", type: "uint256", indexed: true },
          { name: "fulfillment", type: "bytes", indexed: false },
        ],
      },
      args: {
        id: requestId,
      },
      fromBlock,
      toBlock: currentBlock,
    });

    if (logs.length === 0) {
      return {
        type: "retry",
        message: "request reported as fulfilled but no RequestFulfilled event found",
      };
    }

    const log = logs[0];
    const fulfillmentBytes = log.args.fulfillment;
    if (!fulfillmentBytes) {
      return {
        type: "retry",
        message: "RequestFulfilled event missing fulfillment data",
      };
    }

    fulfillmentData = decodeFulfillment(fulfillmentBytes);
  } catch (error) {
    return {
      type: "retry",
      message: `failed fetching fulfillment event: ${safeErrorMessage(error)}`,
    };
  }

  // 3. Convert fulfillment to the prover response format
  const proverResponse = adaptFulfillmentToProverResponse(fulfillmentData);

  return {
    type: "success",
    response: proverResponse,
  };
}

/**
 * Polling loop for Boundless fulfillment, with budget/timeout.
 */
export async function pollBoundless(
  config: BoundlessConfig,
  requestIdHex: string,
  budgetMs: number,
): Promise<ProverPollResult> {
  const budgetDeadline = Date.now() + budgetMs;
  const absoluteDeadline = Date.now() + config.pollTimeoutMs;

  /* eslint-disable no-await-in-loop */
  while (Date.now() < budgetDeadline && Date.now() < absoluteDeadline) {
    const result = await pollBoundlessOnce(config, requestIdHex);

    if (result.type !== "running") {
      return result;
    }

    if (Date.now() + config.pollIntervalMs >= budgetDeadline) {
      return result;
    }

    await sleep(config.pollIntervalMs);
  }
  /* eslint-enable no-await-in-loop */

  return {
    type: "running",
    status: "running",
  };
}

/**
 * Decode the fulfillment bytes from the RequestFulfilled event.
 *
 * Fulfillment encoding (ABI-encoded struct):
 * - journal_digest (bytes32)
 * - seal (bytes, dynamic)
 * - journal (bytes, dynamic)
 */
function decodeFulfillment(fulfillmentHex: Hex): FulfillmentData {
  const bytes = hexToUint8Array(fulfillmentHex);

  // ABI-encoded: first 32 bytes = journal_digest, then dynamic offsets for seal and journal
  // Skip journal_digest (32 bytes)
  // offset to seal (32 bytes at position 32)
  // offset to journal (32 bytes at position 64)
  if (bytes.length < 96) {
    throw new Error(`fulfillment data too short: ${bytes.length} bytes`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sealOffset = Number(readUint256(view, 32));
  const journalOffset = Number(readUint256(view, 64));

  const sealLen = Number(readUint256(view, sealOffset));
  const seal = bytes.slice(sealOffset + 32, sealOffset + 32 + sealLen);

  const journalLen = Number(readUint256(view, journalOffset));
  const journal = bytes.slice(journalOffset + 32, journalOffset + 32 + journalLen);

  return { seal, journal };
}

function readUint256(view: DataView, offset: number): bigint {
  // Read 32 bytes as big-endian uint256
  let result = 0n;
  for (let i = 0; i < 32; i++) {
    result = (result << 8n) | BigInt(view.getUint8(offset + i));
  }
  return result;
}

function hexToUint8Array(hex: Hex): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
