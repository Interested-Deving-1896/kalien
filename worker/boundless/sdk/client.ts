/**
 * Boundless SDK — BoundlessClient class.
 *
 * Provides a clean, typed interface for submitting proof requests to the
 * Boundless ZK proof marketplace and polling for fulfillment.
 *
 * The Boundless flow:
 *   1. Encode the guest input (stdin) into GuestEnv V1 msgpack format
 *   2. Upload to IPFS (Pinata) if stdin > MAX_INLINE_STDIN_BYTES
 *   3. Build a ProofRequest with a reverse Dutch auction offer
 *   4. Sign the request with EIP-712
 *   5. Submit on-chain (createWalletClient.writeContract)
 *   6. Also POST to the off-chain order stream so provers discover it faster
 *   7. Poll `requestIsFulfilled` until true, then fetch the ProofDelivered event
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { safeErrorMessage, sleep } from "../../utils";
import { MAX_INLINE_STDIN_BYTES } from "../config";
import { boundlessMarketAbi, eip712Types } from "../abi";
import { encodeStdin } from "../stdin";
import { uploadInput } from "../storage";
import { adaptFulfillmentToProverResponse } from "../adapter";
import type { ProverPollResult, ProverSubmitResult } from "../../types";
import type { BoundlessClientConfig, BoundlessFulfillmentData, BoundlessProofRequest } from "./types";
import {
  buildRequestId,
  boundlessExplorerUrl,
  decodeRequestId,
  hexToUint8Array,
  requestIdToHex,
  uint8ArrayToHex,
} from "./utils";

// Predicate type name mapping for the order stream JSON format
const PREDICATE_TYPE_NAMES: Record<number, string> = {
  0: "DigestMatch",
  1: "PrefixMatch",
  2: "ClaimDigestMatch",
};
const INPUT_TYPE_NAMES: Record<number, string> = { 0: "Inline", 1: "Url" };

export class BoundlessClient {
  private readonly config: BoundlessClientConfig;

  constructor(config: BoundlessClientConfig) {
    this.config = config;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Submit a tape to Boundless for proving.
   *
   * Encodes the tape into GuestEnv V1 msgpack format, uploads to IPFS if
   * needed, builds + signs + submits the on-chain ProofRequest, and also
   * posts to the order stream for faster prover discovery.
   *
   * Returns a ProverSubmitResult for compatibility with the existing
   * coordinator flow.
   */
  async submitRequest(tapeBytes: Uint8Array): Promise<ProverSubmitResult> {
    const config = this.config;
    const account = privateKeyToAccount(config.privateKey);

    // 1. Encode stdin into GuestEnv V1 msgpack format
    const stdinBytes = encodeStdin(tapeBytes);

    // 2. Determine input type: upload to IPFS if too large for inline
    let inputType: number;
    let inputData: Hex;
    let ipfsCid: string | undefined;

    if (stdinBytes.length > MAX_INLINE_STDIN_BYTES) {
      if (!config.pinataJwt) {
        return {
          type: "fatal",
          message: `stdin is ${stdinBytes.length} bytes (exceeds ${MAX_INLINE_STDIN_BYTES} inline limit) but PINATA_JWT is not configured`,
        };
      }

      try {
        const upload = await uploadInput(config.pinataJwt, stdinBytes);
        ipfsCid = upload.cid;
        const urlBytes = new TextEncoder().encode(upload.url);
        inputData = `0x${uint8ArrayToHex(new Uint8Array(urlBytes))}` as Hex;
        inputType = 1; // Url
        console.log("[boundless] uploaded stdin to IPFS", {
          url: upload.url,
          cid: ipfsCid,
          stdinBytes: stdinBytes.length,
        });
      } catch (error) {
        return {
          type: "retry",
          message: `failed uploading stdin to IPFS: ${safeErrorMessage(error)}`,
        };
      }
    } else {
      inputData = `0x${uint8ArrayToHex(stdinBytes)}` as Hex;
      inputType = 0; // Inline
    }

    // 3. Build the ProofRequest with a reverse Dutch auction
    //    nonce = Date.now() truncated to uint32 via >>> 0
    const nonce = Date.now() >>> 0;
    const requestId = buildRequestId(account.address, nonce);

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const rampUpStart = nowSec + BigInt(config.flatPeriodSec);

    const proofRequest: BoundlessProofRequest = {
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
        selector: "0x73c457ba", // Groth16V3_0 — Stellar requires standalone Groth16 proofs
      },
      imageUrl: config.imageUrl,
      input: {
        inputType,
        data: inputData,
      },
      offer: {
        minPrice: config.minPrice,
        maxPrice: config.maxPrice,
        rampUpStart,
        rampUpPeriod: config.rampPeriodSec,
        lockTimeout: config.lockTimeoutSec,
        timeout: config.timeoutSec,
        lockCollateral: 0n,
      },
    };

    // Build viem chain config from chainId + rpcUrl
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

    const requestIdHex = requestIdToHex(requestId);
    console.log("[boundless] submitted proof request on-chain", {
      requestId: requestIdHex,
      explorerUrl: this.explorerUrl(requestId),
      txHash,
      stdinBytes: stdinBytes.length,
      inputType: inputType === 1 ? "url" : "inline",
      maxPrice: config.maxPrice.toString(),
      chainId: config.chainId.toString(),
    });

    // 6. Submit to off-chain order stream (best-effort)
    try {
      await this.submitToOrderStream(proofRequest, signature, domain);
      console.log("[boundless] submitted to order stream");
    } catch (error) {
      console.log("[boundless] order stream submission failed (non-fatal):", safeErrorMessage(error));
    }

    return {
      type: "success",
      jobId: requestIdHex,
      statusUrl: `boundless:${requestIdHex}`,
      segmentLimitPo2: 0,
      ipfsCid,
    };
  }

  /**
   * Single poll check for Boundless fulfillment.
   *
   * @param requestIdHex - 0x-prefixed hex string of the request ID
   * @returns ProverPollResult (running | success | retry | fatal)
   */
  async pollOnce(requestIdHex: string): Promise<ProverPollResult> {
    const config = this.config;
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

    // 1. Check if fulfilled on-chain
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

    // 2. Fetch the ProofDelivered event logs (contains seal + journal)
    let fulfillmentData: BoundlessFulfillmentData;
    try {
      const currentBlock = await publicClient.getBlockNumber();
      // Base public RPC limits eth_getLogs to 10,000 blocks; use 9,900 (~5.5h on Base)
      const LOG_SEARCH_WINDOW = 9_900n;
      const fromBlock =
        config.deploymentBlock > currentBlock - LOG_SEARCH_WINDOW
          ? config.deploymentBlock
          : currentBlock - LOG_SEARCH_WINDOW;

      fulfillmentData = await this.fetchFulfillmentFromLogs(
        publicClient,
        requestId,
        fromBlock,
        currentBlock,
      );
    } catch (error) {
      if (error instanceof FulfillmentNotFoundError) {
        return {
          type: "retry",
          message: error.message,
        };
      }
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
   * Poll for Boundless fulfillment with a time budget.
   *
   * Polls at `config.pollIntervalMs` intervals until either:
   * - The request is fulfilled (returns success/fatal)
   * - The budget runs out (returns running — caller should resume later)
   * - The absolute timeout is reached (returns running)
   *
   * @param requestIdHex - 0x-prefixed hex string of the request ID
   * @param budgetMs     - Maximum time to spend polling in this call
   */
  async poll(requestIdHex: string, budgetMs: number): Promise<ProverPollResult> {
    const config = this.config;
    const budgetDeadline = Date.now() + budgetMs;
    const absoluteDeadline = Date.now() + config.pollTimeoutMs;

    /* eslint-disable no-await-in-loop */
    while (Date.now() < budgetDeadline && Date.now() < absoluteDeadline) {
      const result = await this.pollOnce(requestIdHex);

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
   * Get the Boundless explorer URL for a given request ID.
   *
   * @param requestId - bigint request ID
   */
  explorerUrl(requestId: bigint): string {
    return boundlessExplorerUrl(requestId);
  }

  /**
   * Decode a request ID bigint back into its constituent address + nonce.
   *
   * @param requestId - bigint request ID
   */
  decodeRequestId(requestId: bigint): { address: string; nonce: number } {
    return decodeRequestId(requestId);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Submit the signed proof request to the off-chain order stream.
   *
   * Provers monitor the order stream to discover new requests faster than
   * polling the chain. This submission is best-effort — the on-chain
   * submission is the authoritative source of truth.
   */
  private async submitToOrderStream(
    request: BoundlessProofRequest,
    signature: Hex,
    domain: { name: string; version: string; chainId: bigint; verifyingContract: `0x${string}` },
  ): Promise<void> {
    const config = this.config;

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
        id: requestIdToHex(request.id),
        requirements: {
          callback: {
            addr: request.requirements.callback.addr,
            gasLimit: `0x${request.requirements.callback.gasLimit.toString(16)}`,
          },
          predicate: {
            predicateType:
              PREDICATE_TYPE_NAMES[request.requirements.predicate.predicateType] ?? "DigestMatch",
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
   * Fetch the ProofDelivered event for a request ID and decode fulfillment data.
   *
   * Uses raw eth_getLogs with topic filtering and manual hex decoding to avoid
   * viem's decodeAbiParameters BigInt→Number truncation bug for uint256 fields.
   */
  private async fetchFulfillmentFromLogs(
    publicClient: ReturnType<typeof createPublicClient>,
    requestId: bigint,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<BoundlessFulfillmentData> {
    // ProofDelivered event topic0 (keccak256 of signature)
    const PROOF_DELIVERED_TOPIC =
      "0xaf1db8f86d3f32029a484ff54c7ac1d7ef8f038ab050fc065af9e82eb9b850ca" as const;

    // Topic1: requestId padded to 32 bytes (uint256, big-endian)
    const requestIdTopic =
      `0x${requestId.toString(16).padStart(64, "0")}` as `0x${string}`;

    const config = this.config;

    // Use raw eth_getLogs with topic filtering for correctness across RPCs.
    // Some RPCs (e.g. BlastAPI) ignore topic filters and return all contract
    // events — we filter manually by both topic0 and topic1 below.
    const logs = await publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: config.marketAddress,
          topics: [PROOF_DELIVERED_TOPIC, requestIdTopic],
          fromBlock: `0x${fromBlock.toString(16)}` as Hex,
          toBlock: `0x${toBlock.toString(16)}` as Hex,
        },
      ],
    });

    const ourLog = (logs as Array<{ topics?: string[]; data?: string }>).find((log) => {
      const topic0 = log.topics?.[0]?.toLowerCase();
      const topic1 = log.topics?.[1]?.toLowerCase();
      return (
        topic0 === PROOF_DELIVERED_TOPIC.toLowerCase() &&
        topic1 === requestIdTopic.toLowerCase()
      );
    });

    if (!ourLog?.data) {
      throw new FulfillmentNotFoundError(
        "request reported as fulfilled but no ProofDelivered event found in block range",
      );
    }

    return this.parseFulfillmentFromEventData(ourLog.data);
  }

  /**
   * Parse a ProofDelivered event's data field into seal + journal bytes.
   *
   * Manually decodes the ABI-encoded Fulfillment struct without using
   * decodeAbiParameters, avoiding the uint256→Number truncation bug.
   *
   * ProofDelivered event data layout: abi.encode(Fulfillment)
   *
   * Fulfillment struct:
   *   - id (uint256)          — word 0: skip
   *   - requestDigest (bytes32) — word 1: skip
   *   - claimDigest (bytes32)   — word 2: skip
   *   - fulfillmentDataType (uint8) — word 3
   *   - fulfillmentData (bytes) — word 4: offset (relative to tuple head)
   *   - seal (bytes)           — word 5: offset (relative to tuple head)
   *   Then dynamic data follows.
   *
   * The event non-indexed data is: abi.encode(Fulfillment)
   * which is: offset_to_tuple (0x20), then the tuple.
   */
  private parseFulfillmentFromEventData(data: string): BoundlessFulfillmentData {
    const clean = data.startsWith("0x") ? data.slice(2) : data;

    const readWordAt = (charOffset: number): string => clean.slice(charOffset, charOffset + 64);
    const readUintAt = (charOffset: number): number =>
      Number.parseInt(readWordAt(charOffset), 16);

    // Outer: word 0 is the offset to the Fulfillment tuple (always 0x20 = 32 bytes)
    const tupleByteOffset = readUintAt(0);
    const t = tupleByteOffset * 2; // tuple start in hex chars

    // Fulfillment head (each field = 32 bytes = 64 hex chars):
    //   word 0 (t + 0*64): id (uint256) — skip
    //   word 1 (t + 1*64): requestDigest (bytes32) — skip
    //   word 2 (t + 2*64): claimDigest (bytes32) — skip
    //   word 3 (t + 3*64): fulfillmentDataType (uint8)
    //   word 4 (t + 4*64): fulfillmentData offset (relative to tuple start)
    //   word 5 (t + 5*64): seal offset (relative to tuple start)
    const fulfillmentDataType = readUintAt(t + 3 * 64);
    const fdByteOffset = readUintAt(t + 4 * 64);
    const sealByteOffset = readUintAt(t + 5 * 64);

    // Read seal: length-prefixed bytes at (t + sealByteOffset * 2)
    const sealLenCharOffset = t + sealByteOffset * 2;
    const sealLen = readUintAt(sealLenCharOffset);
    const sealHex = clean.slice(sealLenCharOffset + 64, sealLenCharOffset + 64 + sealLen * 2);
    const seal = hexToUint8Array(sealHex);

    if (fulfillmentDataType !== 1) {
      throw new Error(
        `unexpected fulfillmentDataType: ${fulfillmentDataType} (expected 1 = ImageIdAndJournal)`,
      );
    }

    // Read fulfillmentData: length-prefixed bytes at (t + fdByteOffset * 2)
    const fdLenCharOffset = t + fdByteOffset * 2;
    const fdLen = readUintAt(fdLenCharOffset);
    const fdHex = clean.slice(fdLenCharOffset + 64, fdLenCharOffset + 64 + fdLen * 2);

    // fulfillmentData = abi.encode((bytes32 imageId, bytes journal))
    // This is a tuple, so it may be prefixed by a tuple offset word (0x20 = 32).
    // Check the first word: if it's 32 (0x20), skip it.
    const firstWordVal = Number.parseInt(fdHex.slice(0, 64), 16);
    const innerHex = firstWordVal === 32 ? fdHex.slice(64) : fdHex;

    // innerHex layout:
    //   word 0: imageId (bytes32) — skip
    //   word 1: offset to journal bytes (relative to inner start)
    //   at (journalByteOffset * 2): journal length word
    //   at (journalByteOffset * 2 + 64): journal data
    const journalByteOffset = Number.parseInt(innerHex.slice(64, 128), 16);
    const journalLen = Number.parseInt(
      innerHex.slice(journalByteOffset * 2, journalByteOffset * 2 + 64),
      16,
    );
    const journalHex = innerHex.slice(
      journalByteOffset * 2 + 64,
      journalByteOffset * 2 + 64 + journalLen * 2,
    );
    const journal = hexToUint8Array(journalHex);

    return { seal, journal };
  }
}

/**
 * Error thrown when a fulfilled request's ProofDelivered event cannot be found.
 * This can happen if the event was emitted outside the search window — the
 * caller should retry with a wider block range or after a delay.
 */
export class FulfillmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FulfillmentNotFoundError";
  }
}
