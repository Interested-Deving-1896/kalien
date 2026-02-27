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
import { BOUNDLESS_INDEXER_URLS, MAX_INLINE_STDIN_BYTES } from "../config";
import { boundlessMarketAbi, eip712Types } from "../abi";
import { encodeStdin } from "../stdin";
import { uploadInput } from "../storage";
import { fetchEthPriceUsd, usdToWei, weiToUsd } from "../pricing";
import { adaptFulfillmentToProverResponse } from "../adapter";
import { parseAndValidateTape } from "../../tape";
import { DEFAULT_MAX_TAPE_BYTES } from "../../constants";
import type { ProverPollResult, ProverSubmitResult } from "../../types";
import type {
  BoundlessClientConfig,
  BoundlessFulfillmentData,
  BoundlessProofRequest,
} from "./types";
import {
  buildRequestId,
  boundlessExplorerUrl,
  hexToUint8Array,
  requestIdToHex,
  uint8ArrayToHex,
} from "./utils";
import { packJournalRaw } from "../../../shared/stellar/journal";

function parsePositiveNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

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
   * Returns a ProverSubmitResult consumed by the coordinator flow.
   */
  async submitRequest(
    tapeBytes: Uint8Array,
    metadata: { seedId: number; claimantAddress: string },
  ): Promise<ProverSubmitResult> {
    const config = this.config;
    const account = privateKeyToAccount(config.privateKey);

    // 1. Resolve USD pricing to wei via Chainlink ETH/USD feed
    let ethPriceUsd: number;
    let minPrice: bigint;
    let maxPrice: bigint;
    try {
      ethPriceUsd = await fetchEthPriceUsd(config.rpcUrl, Number(config.chainId));
      minPrice = usdToWei(config.minPriceUsd, ethPriceUsd);
      maxPrice = usdToWei(config.maxPriceUsd, ethPriceUsd);
      console.log("[boundless] ETH price", {
        ethPriceUsd: ethPriceUsd.toFixed(2),
        maxPriceUsd: config.maxPriceUsd,
        maxPriceWei: maxPrice.toString(),
        minPriceUsd: config.minPriceUsd,
        minPriceWei: minPrice.toString(),
      });
    } catch (error) {
      return {
        type: "retry",
        message: `failed fetching ETH price for USD pricing: ${safeErrorMessage(error)}`,
      };
    }

    // 2. Encode stdin into GuestEnv V1 msgpack format
    const stdinBytes = encodeStdin(tapeBytes, {
      seedId: metadata.seedId >>> 0,
      claimantAddress: metadata.claimantAddress,
    });

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

    // Compute DigestMatch predicate: bind proof request to this exact tape by
    // precomputing the expected journal.
    // and using sha256(journal) as the predicate data.
    const tapeMeta = parseAndValidateTape(tapeBytes, DEFAULT_MAX_TAPE_BYTES);
    let expectedJournal: Uint8Array;
    try {
      expectedJournal = packJournalRaw({
        seed_id: metadata.seedId >>> 0,
        seed: tapeMeta.seed,
        frame_count: tapeMeta.frameCount,
        final_score: tapeMeta.finalScore,
        claimant: metadata.claimantAddress,
      });
    } catch (error) {
      return {
        type: "fatal",
        message: `failed building expected journal: ${safeErrorMessage(error)}`,
      };
    }
    const digestInput = expectedJournal as unknown as BufferSource;
    const journalDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
    // DigestMatch data = abi.encodePacked(imageId, sha256(journal)) = 64 bytes
    const imageIdBytes = hexToUint8Array(config.imageId as Hex);
    const predicateData = new Uint8Array(64);
    predicateData.set(imageIdBytes, 0);
    predicateData.set(journalDigest, 32);
    const predicateDataHex = `0x${uint8ArrayToHex(predicateData)}` as Hex;

    const proofRequest: BoundlessProofRequest = {
      id: requestId,
      requirements: {
        callback: {
          addr: "0x0000000000000000000000000000000000000000",
          gasLimit: 0n,
        },
        predicate: {
          predicateType: 0, // DigestMatch — proof must produce this exact journal from this image
          data: predicateDataHex,
        },
        selector: "0x73c457ba", // Groth16V3_0 — Stellar requires standalone Groth16 proofs
      },
      imageUrl: config.imageUrl,
      input: {
        inputType,
        data: inputData,
      },
      offer: {
        minPrice,
        maxPrice,
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
        value: maxPrice,
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
      maxPriceWei: maxPrice.toString(),
      maxPriceUsd: config.maxPriceUsd,
      predicateData: predicateDataHex,
      chainId: config.chainId.toString(),
    });

    // 6. Submit to off-chain order stream (best-effort)
    try {
      await this.submitToOrderStream(proofRequest, signature, domain);
      console.log("[boundless] submitted to order stream");
    } catch (error) {
      console.log(
        "[boundless] order stream submission failed (non-fatal):",
        safeErrorMessage(error),
      );
    }

    return {
      type: "success",
      jobId: requestIdHex,
      statusUrl: `boundless:${requestIdHex}`,
      segmentLimitPo2: 0,
      ipfsCid,
      maxPriceUsd: config.maxPriceUsd,
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
      // Check if a prover has locked the order
      let locked: boolean | undefined;
      let lockPriceWei: bigint | undefined;
      try {
        locked = await publicClient.readContract({
          address: config.marketAddress,
          abi: boundlessMarketAbi,
          functionName: "requestIsLocked",
          args: [requestId],
        });
      } catch {
        // Non-fatal — lock status is advisory; default to undefined (unknown)
      }

      // Read lock price while it's still available (cleared after payment)
      if (locked) {
        try {
          const [, , , , price] = await publicClient.readContract({
            address: config.marketAddress,
            abi: boundlessMarketAbi,
            functionName: "requestLocks",
            args: [requestId],
          });
          if (price > 0n) lockPriceWei = price;
        } catch { /* non-fatal */ }
      }

      return {
        type: "running",
        status: "running",
        locked,
        lockPriceWei,
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

    // 3. Fetch settlement cost + cycle counts in parallel — both non-fatal enrichment
    const [costResult, cyclesResult] = await Promise.allSettled([
      (async (): Promise<number | null> => {
        const [, , , , lockPrice] = await publicClient.readContract({
          address: config.marketAddress,
          abi: boundlessMarketAbi,
          functionName: "requestLocks",
          args: [requestId],
        });
        if (lockPrice <= 0n) return null;
        const ethPrice = await fetchEthPriceUsd(config.rpcUrl, Number(config.chainId));
        return weiToUsd(lockPrice, ethPrice);
      })(),
      this.fetchCyclesFromIndexer(requestId),
    ]);

    const actualCostUsd = costResult.status === "fulfilled" ? costResult.value : null;
    const { programCycles, totalCycles } =
      cyclesResult.status === "fulfilled"
        ? cyclesResult.value
        : { programCycles: null, totalCycles: null };

    // 4. Convert fulfillment to the prover response format
    const proverResponse = adaptFulfillmentToProverResponse(fulfillmentData);

    return {
      type: "success",
      response: proverResponse,
      metadata: {
        actualCostUsd,
        proverAddress: fulfillmentData.proverAddress,
        fulfillmentTxHash: fulfillmentData.fulfillmentTxHash,
        programCycles,
        totalCycles,
      },
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

    let lastResult: ProverPollResult = { type: "running", status: "running" };

    /* eslint-disable no-await-in-loop */
    while (Date.now() < budgetDeadline && Date.now() < absoluteDeadline) {
      const result = await this.pollOnce(requestIdHex);
      lastResult = result;

      if (result.type !== "running") {
        return result;
      }

      if (Date.now() + config.pollIntervalMs >= budgetDeadline) {
        return result;
      }

      await sleep(config.pollIntervalMs);
    }
    /* eslint-enable no-await-in-loop */

    return lastResult;
  }

  /**
   * Get the Boundless explorer URL for a given request ID.
   *
   * @param requestId - bigint request ID
   */
  explorerUrl(requestId: bigint): string {
    return boundlessExplorerUrl(requestId);
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
    const requestIdTopic = `0x${requestId.toString(16).padStart(64, "0")}` as `0x${string}`;

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

    const ourLog = (logs as Array<{ topics?: string[]; data?: string; transactionHash?: string }>).find((log) => {
      const topic0 = log.topics?.[0]?.toLowerCase();
      const topic1 = log.topics?.[1]?.toLowerCase();
      return (
        topic0 === PROOF_DELIVERED_TOPIC.toLowerCase() && topic1 === requestIdTopic.toLowerCase()
      );
    });

    if (!ourLog?.data) {
      throw new FulfillmentNotFoundError(
        "request reported as fulfilled but no ProofDelivered event found in block range",
      );
    }

    // Extract prover address from topics[2] (indexed address, left-padded to 32 bytes)
    const proverAddress = ourLog.topics?.[2]
      ? `0x${ourLog.topics[2].slice(-40)}`
      : null;
    const fulfillmentTxHash = ourLog.transactionHash ?? null;

    const result = this.parseFulfillmentFromEventData(ourLog.data);
    return { ...result, proverAddress, fulfillmentTxHash };
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
    const readUintAt = (charOffset: number): number => Number.parseInt(readWordAt(charOffset), 16);

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

    return { seal, journal, proverAddress: null, fulfillmentTxHash: null };
  }

  private async fetchCyclesFromIndexer(
    requestId: bigint,
  ): Promise<{ programCycles: number | null; totalCycles: number | null }> {
    return fetchBoundlessCycles(this.config.chainId.toString(), requestIdToHex(requestId));
  }
}

/**
 * Fetch cycle counts for a fulfilled request from the Boundless Indexer API.
 *
 * The indexer computes program_cycles and total_cycles via Bento re-execution.
 * These may be null if Bento hasn't processed the request yet.
 * Returns null values for chains without a known indexer URL.
 *
 * Exported so the coordinator can call it for lazy backfill on read.
 */
export async function fetchBoundlessCycles(
  chainId: string,
  requestIdHex: string,
): Promise<{ programCycles: number | null; totalCycles: number | null }> {
  const primaryIndexerUrl = BOUNDLESS_INDEXER_URLS[chainId];
  const candidateUrls = [
    ...(primaryIndexerUrl ? [`${primaryIndexerUrl}/v1/market/requests/${requestIdHex}`] : []),
    // Fallback to Explorer's public API; it proxies indexer backends server-side.
    `https://explorer.boundless.network/api/orders/${requestIdHex}`,
  ];

  const cycleResults = await Promise.all(
    candidateUrls.map(async (url) => {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) {
          return null;
        }

        const payload = (await resp.json()) as unknown;
        const entry =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as {
                program_cycles?: string | number | null;
                total_program_cycles?: string | number | null;
                total_cycles?: string | number | null;
              })
            : null;
        if (!entry) {
          return null;
        }

        const programCycles = parsePositiveNumber(entry.program_cycles ?? entry.total_program_cycles);
        const totalCycles = parsePositiveNumber(entry.total_cycles);
        if (totalCycles == null && programCycles == null) {
          return null;
        }

        return { source: url, programCycles, totalCycles };
      } catch {
        return null;
      }
    }),
  );

  const firstWithCycles = cycleResults.find((result) => result != null);
  if (firstWithCycles) {
    if (firstWithCycles.totalCycles != null) {
      console.log("[boundless] indexer cycles", {
        programCycles: firstWithCycles.programCycles,
        totalCycles: firstWithCycles.totalCycles,
        requestId: requestIdHex,
        source: firstWithCycles.source,
      });
    }

    return {
      programCycles: firstWithCycles.programCycles,
      totalCycles: firstWithCycles.totalCycles,
    };
  }

  return { programCycles: null, totalCycles: null };
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
