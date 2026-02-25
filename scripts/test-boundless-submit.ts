/**
 * E2E test: Boundless proof → Stellar claim pipeline.
 *
 * Full mode (submits new proof request with fresh tape):
 *   bun run scripts/test-boundless-submit.ts
 *
 * Claim-only mode (uses existing fulfilled request):
 *   bun run scripts/test-boundless-submit.ts --request-id 0x...
 *
 * Secrets (loaded from scripts/.env → .dev.vars → .env, highest priority first):
 *   BOUNDLESS_PRIVATE_KEY  — EVM wallet private key (only needed in full mode)
 *   PINATA_JWT             — Pinata API JWT for IPFS uploads (only needed in full mode)
 *   RELAYER_API_KEY        — OpenZeppelin Relayer key for Stellar claim
 */

import {
  createPublicClient,
  createWalletClient,
  hashTypedData,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { encodeStdin } from "../worker/boundless/stdin";
import { boundlessMarketAbi, eip712Types } from "../worker/boundless/abi";
import type { ProofRequest } from "../worker/boundless/types";
import { adaptFulfillmentToProverResponse } from "../worker/boundless/adapter";
import { Client as ScoreContractClient } from "../shared/stellar/bindings/asteroids-score/dist/index.js";
import {
  ChannelsClient,
} from "@openzeppelin/relayer-plugin-channels/dist/client";
import { AsteroidsGame } from "../src/game/AsteroidsGame";
import { Autopilot } from "../src/game/Autopilot";
import { env } from "./load-env";

// ── Parse CLI args ───────────────────────────────────────────────────────
const requestIdArg = (() => {
  const idx = process.argv.indexOf("--request-id");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();
const claimOnly = requestIdArg !== null;

// ── Validate secrets ──────────────────────────────────────────────────────
if (!claimOnly && (!env.BOUNDLESS_PRIVATE_KEY || !env.PINATA_JWT)) {
  console.error("Missing BOUNDLESS_PRIVATE_KEY or PINATA_JWT in scripts/.env, .dev.vars, or .env");
  process.exit(1);
}
if (!env.RELAYER_API_KEY) {
  console.error("Missing RELAYER_API_KEY in scripts/.env, .dev.vars, or .env");
  process.exit(1);
}

// ── Base Mainnet deployment ──────────────────────────────────────────────
const CHAIN_ID = 8453n;
const MARKET_ADDRESS = "0xfd152dadc5183870710fe54f939eae3ab9f0fe82" as const;
const ORDER_STREAM_URL = "https://base-mainnet.boundless.network";
// BlastAPI is reliable for eth_getLogs (mainnet.base.org returns 503)
const RPC_URL = "https://base-mainnet.public.blastapi.io";

const RELAYER_API_KEY = env.RELAYER_API_KEY;
const IMAGE_URL = "https://gateway.pinata.cloud/ipfs/QmRCff7XUQm4rYDALBBxMZmv5yMRG6nHXUNCjgd8JdCMwr";
const IMAGE_ID = "0xc2d61eb93372c44376c6c46eea2656d3c88a67eba4998456d014908d24d5e3a0";

// Groth16V3_0 selector — explicitly request Groth16 proofs for Stellar
const GROTH16_SELECTOR = "0x73c457ba" as const;

const MIN_PRICE = 50000000000n;   // ~$0.0001 — auction floor
const MAX_PRICE = 5000000000000n; // ~$0.01 — auction ceiling
const FLAT_PERIOD_SEC = 120;   // 2 min prover discovery window before ramp
const RAMP_PERIOD_SEC = 480;   // 8 min for price to ramp from minPrice to maxPrice
const LOCK_TIMEOUT_SEC = 1680; // 28 min from rampUpStart (8m ramp + 20m at max price)
const TIMEOUT_SEC = 3480;      // lock (28m) + 30m expiry = 60m total
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 65 * 60_000; // 65 minutes
const MAX_FRAMES = 36_000;

// Stellar testnet config
const SCORE_CONTRACT_ID = "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";
const STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
const RELAYER_URL = "https://channels.openzeppelin.com/testnet";
const CLAIMANT_ADDRESS = "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX";

// Event fetch retry config
const EVENT_FETCH_RETRIES = 15;
const EVENT_FETCH_BACKOFF_MS = 20_000;

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// ProofDelivered event topic0
const PROOF_DELIVERED_TOPIC = "0xaf1db8f86d3f32029a484ff54c7ac1d7ef8f038ab050fc065af9e82eb9b850ca" as const;

// ── Helpers ──────────────────────────────────────────────────────────────
function formatEth(wei: bigint): string {
  const whole = wei / 1000000000000000000n;
  const frac = wei % 1000000000000000000n;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "") || "0";
  return `${whole}.${fracStr}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Generate a fresh tape using the headless autopilot. */
function generateFreshTape(): Uint8Array {
  const seed = Date.now();
  console.log(`  Generating tape with seed 0x${seed.toString(16).padStart(8, "0")}...`);
  const game = new AsteroidsGame({ headless: true, seed });
  game.startNewGame(seed);
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  while (frame < MAX_FRAMES) {
    game.stepSimulation();
    frame++;
    if (game.getMode() === "game-over") break;
  }

  const tapeData = game.getTape();
  if (!tapeData) {
    console.error("  Failed to generate tape");
    process.exit(1);
  }

  console.log(`  Tape: ${frame} frames, score ${game.getScore()}, wave ${game.getWave()} (${tapeData.length} bytes)`);
  return new Uint8Array(tapeData);
}

/**
 * Parse a ProofDelivered event's data field manually.
 * Avoids viem's decodeAbiParameters which has a BigInt-to-Number bug with uint256 fields.
 *
 * Event data layout: abi.encode(Fulfillment)
 *   word 0: offset to tuple (0x20 = 32)
 *   Tuple (Fulfillment):
 *     word 0: id (uint256) — skip
 *     word 1: requestDigest (bytes32) — skip
 *     word 2: claimDigest (bytes32) — skip
 *     word 3: fulfillmentDataType (uint8)
 *     word 4: offset to fulfillmentData (relative to tuple start)
 *     word 5: offset to seal (relative to tuple start)
 *   Dynamic data follows.
 *
 * fulfillmentData (when type=1, ImageIdAndJournal) = abi.encode(bytes32, bytes):
 *     word 0: imageId (bytes32)
 *     word 1: offset to journal (0x40 = 64)
 *     word 2: journal length
 *     word 3+: journal data
 */
function parseFulfillmentFromEventData(data: string): { seal: Uint8Array; journal: Uint8Array } | null {
  const clean = data.startsWith("0x") ? data.slice(2) : data;
  const readWordAt = (charOffset: number) => clean.slice(charOffset, charOffset + 64);
  const readUintAt = (charOffset: number) => Number.parseInt(readWordAt(charOffset), 16);

  // Outer: offset to Fulfillment tuple
  const tupleByteOffset = readUintAt(0);
  const t = tupleByteOffset * 2; // tuple start in hex chars

  // Fulfillment head
  const fulfillmentDataType = readUintAt(t + 3 * 64);
  const fdByteOffset = readUintAt(t + 4 * 64);
  const sealByteOffset = readUintAt(t + 5 * 64);

  // Read seal: length-prefixed bytes at sealByteOffset from tuple start
  const sealLenPos = t + sealByteOffset * 2;
  const sealLen = readUintAt(sealLenPos);
  const seal = hexToBytes(clean.slice(sealLenPos + 64, sealLenPos + 64 + sealLen * 2));

  if (fulfillmentDataType !== 1) {
    console.error(`  Unexpected fulfillmentDataType: ${fulfillmentDataType} (expected 1 = ImageIdAndJournal)`);
    return null;
  }

  // Read fulfillmentData: length-prefixed bytes at fdByteOffset from tuple start
  const fdLenPos = t + fdByteOffset * 2;
  const fdLen = readUintAt(fdLenPos);
  const fdHex = clean.slice(fdLenPos + 64, fdLenPos + 64 + fdLen * 2);

  // fulfillmentData = abi.encode((bytes32, bytes)) — tuple-wrapped.
  // Skip the leading tuple offset (0x20) to get to the actual struct data.
  const firstWord = readUintAt(fdLenPos + 64);
  const innerHex = firstWord === 32 ? fdHex.slice(64) : fdHex;

  // innerHex layout: imageId (bytes32) | offset to journal | journal length | journal data
  const journalByteOffset = Number.parseInt(innerHex.slice(64, 128), 16);
  const journalLen = Number.parseInt(innerHex.slice(journalByteOffset * 2, journalByteOffset * 2 + 64), 16);
  const journal = hexToBytes(innerHex.slice(journalByteOffset * 2 + 64, journalByteOffset * 2 + 64 + journalLen * 2));

  return { seal, journal };
}

// ── Route: Full mode vs claim-only ───────────────────────────────────────
let requestId: bigint;

if (claimOnly) {
  // ── Claim-only mode ────────────────────────────────────────────────────
  requestId = BigInt(requestIdArg);
  console.log("=== Boundless → Stellar E2E Test (claim-only mode) ===\n");
  console.log("Request ID:", requestIdArg);
  console.log("Claimant:", CLAIMANT_ADDRESS);
  console.log("");

  // Verify the request is actually fulfilled
  console.log("Verifying request is fulfilled...");
  const fulfilled = await publicClient.readContract({
    address: MARKET_ADDRESS,
    abi: boundlessMarketAbi,
    functionName: "requestIsFulfilled",
    args: [requestId],
  });
  if (!fulfilled) {
    console.error("  Request is NOT fulfilled. Use full mode to submit a new request.");
    process.exit(1);
  }
  console.log("  Confirmed: request is fulfilled on-chain\n");
} else {
  // ── Full mode: Generate tape + Submit to Boundless ──────────────────────
  const PRIVATE_KEY = env.BOUNDLESS_PRIVATE_KEY;
  const PINATA_JWT = env.PINATA_JWT;
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  console.log("=== Boundless → Stellar E2E Test ===\n");
  console.log("Wallet:", account.address);
  console.log("Contract:", MARKET_ADDRESS);
  console.log("Selector:", GROTH16_SELECTOR, "(Groth16V3_0)");
  console.log("Price:", `${formatEth(MIN_PRICE)} → ${formatEth(MAX_PRICE)} ETH`);
  console.log(`Auction: ${FLAT_PERIOD_SEC / 60}m flat + ${RAMP_PERIOD_SEC / 60}m ramp + ${(LOCK_TIMEOUT_SEC - RAMP_PERIOD_SEC) / 60}m lock + ${(TIMEOUT_SEC - LOCK_TIMEOUT_SEC) / 60}m expiry = ${(FLAT_PERIOD_SEC + TIMEOUT_SEC) / 60}m total`);
  console.log("Claimant:", CLAIMANT_ADDRESS);
  console.log("");

  // Step 0: Generate fresh tape + encode stdin + upload to IPFS
  console.log("Step 0: Generating tape & uploading to IPFS...");
  const tapeBytes = generateFreshTape();
  const stdinBytes = encodeStdin(tapeBytes);
  console.log(`  Stdin: ${stdinBytes.length} bytes`);

  const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(stdinBytes));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  const filename = `${hashHex}.input`;

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(stdinBytes)], { type: "application/octet-stream" }), filename);
  formData.append("pinataMetadata", JSON.stringify({ name: filename }));

  const pinataResp = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData,
  });

  if (!pinataResp.ok) {
    const err = await pinataResp.text().catch(() => "");
    console.error(`  Pinata upload failed: ${pinataResp.status} ${err}`);
    process.exit(1);
  }

  const pinataResult = (await pinataResp.json()) as { IpfsHash?: string };
  if (!pinataResult.IpfsHash) {
    console.error("  Pinata response missing IpfsHash");
    process.exit(1);
  }
  const stdinUrl = `https://gateway.pinata.cloud/ipfs/${pinataResult.IpfsHash}`;
  console.log(`  Uploaded: ${stdinUrl}`);

  const stdinUrlHex = `0x${Array.from(new TextEncoder().encode(stdinUrl)).map(b => b.toString(16).padStart(2, "0")).join("")}` as Hex;

  // Step 1: Build + sign + submit on-chain
  console.log("\nStep 1: Signing & submitting on-chain...");
  const t0 = Date.now();

  const nonce = Date.now();
  requestId = (BigInt(account.address) << 32n) | BigInt(nonce >>> 0);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rampUpStart = nowSec + BigInt(FLAT_PERIOD_SEC);

  const proofRequest: ProofRequest = {
    id: requestId,
    requirements: {
      callback: {
        addr: "0x0000000000000000000000000000000000000000",
        gasLimit: 0n,
      },
      predicate: {
        predicateType: 1,
        data: IMAGE_ID,
      },
      selector: GROTH16_SELECTOR,
    },
    imageUrl: IMAGE_URL,
    input: {
      inputType: 1,
      data: stdinUrlHex,
    },
    offer: {
      minPrice: MIN_PRICE,
      maxPrice: MAX_PRICE,
      rampUpStart,
      rampUpPeriod: RAMP_PERIOD_SEC,
      lockTimeout: LOCK_TIMEOUT_SEC,
      timeout: TIMEOUT_SEC,
      lockCollateral: 0n,
    },
  };

  const domain = {
    name: "IBoundlessMarket" as const,
    version: "1" as const,
    chainId: CHAIN_ID,
    verifyingContract: MARKET_ADDRESS,
  };

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  const signature = await walletClient.signTypedData({
    domain,
    types: eip712Types,
    primaryType: "ProofRequest",
    message: proofRequest,
  });

  const txHash = await walletClient.writeContract({
    address: MARKET_ADDRESS,
    abi: boundlessMarketAbi,
    functionName: "submitRequest",
    args: [proofRequest, signature],
    value: MAX_PRICE,
  });

  const requestIdHex = `0x${requestId.toString(16)}`;
  const submitMs = Date.now() - t0;
  console.log(`  On-chain tx: ${txHash} (${(submitMs / 1000).toFixed(1)}s)`);
  console.log(`  BaseScan: https://basescan.org/tx/${txHash}`);
  console.log(`  Request ID: ${requestIdHex}`);

  // Step 2: Submit to order stream
  try {
    const requestDigest = hashTypedData({
      domain,
      types: eip712Types,
      primaryType: "ProofRequest",
      message: proofRequest,
    });

    const sigClean = signature.slice(2);
    const r = `0x${sigClean.slice(0, 64)}`;
    const s = `0x${sigClean.slice(64, 128)}`;
    const v = Number.parseInt(sigClean.slice(128, 130), 16);
    const yParity = v >= 27 ? v - 27 : v;

    const orderBody = {
      request: {
        id: requestIdHex,
        requirements: {
          callback: { addr: proofRequest.requirements.callback.addr, gasLimit: "0x0" },
          predicate: { predicateType: "PrefixMatch", data: proofRequest.requirements.predicate.data },
          selector: proofRequest.requirements.selector,
        },
        imageUrl: proofRequest.imageUrl,
        input: { inputType: "Url", data: stdinUrlHex },
        offer: {
          minPrice: `0x${proofRequest.offer.minPrice.toString(16)}`,
          maxPrice: `0x${proofRequest.offer.maxPrice.toString(16)}`,
          rampUpStart: Number(proofRequest.offer.rampUpStart),
          rampUpPeriod: proofRequest.offer.rampUpPeriod,
          lockTimeout: proofRequest.offer.lockTimeout,
          timeout: proofRequest.offer.timeout,
          lockCollateral: "0x0",
        },
      },
      request_digest: requestDigest,
      signature: { r, s, yParity: `0x${yParity.toString(16)}`, v: `0x${yParity.toString(16)}` },
    };

    const resp = await fetch(`${ORDER_STREAM_URL}/api/v1/submit_order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderBody),
    });
    const osBody = await resp.text().catch(() => "");
    console.log(`  Order stream: ${resp.status} - ${osBody}`);
  } catch (e: any) {
    console.log(`  Order stream: failed (non-fatal) - ${e.message}`);
  }

  console.log(`\n  Submitted. ${FLAT_PERIOD_SEC / 60}m flat + ${RAMP_PERIOD_SEC / 60}m ramp starting.`);
  console.log(`  Price: ${formatEth(MIN_PRICE)} → ${formatEth(MAX_PRICE)} ETH`);

  // Step 3: Poll for fulfillment
  console.log("\nStep 3: Polling for fulfillment...");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`  [${elapsed}s] Poll #${attempt}... `);

    try {
      const fulfilled = await publicClient.readContract({
        address: MARKET_ADDRESS,
        abi: boundlessMarketAbi,
        functionName: "requestIsFulfilled",
        args: [requestId],
      });

      if (fulfilled) {
        console.log("FULFILLED!");
        const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n  Boundless fulfillment time: ${totalSec}s`);
        break;
      }

      console.log("running");
    } catch (e: any) {
      console.log(`error: ${e.message?.slice(0, 80)}`);
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\nTimed out after ${totalSec}s (${attempt} polls).`);
      console.log("Request ID:", requestIdHex);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── Step 4: Fetch ProofDelivered event (with retries) ────────────────────
// Uses raw topic-based log fetching + manual hex parsing to avoid viem's
// BigInt-to-Number conversion bug with uint256 fields in the Fulfillment struct.
console.log("Step 4: Fetching ProofDelivered event...");
let seal: Uint8Array | null = null;
let journal: Uint8Array | null = null;

const requestIdTopic = `0x${requestId.toString(16).padStart(64, "0")}` as Hex;

for (let eventAttempt = 1; eventAttempt <= EVENT_FETCH_RETRIES; eventAttempt++) {
  try {
    const currentBlock = await publicClient.getBlockNumber();
    // BlastAPI ignores topic filters, returns ALL contract events.
    // We filter manually by topic[0] (event sig) AND topic[1] (requestId).
    const logs = await publicClient.request({
      method: "eth_getLogs",
      params: [{
        address: MARKET_ADDRESS,
        topics: [PROOF_DELIVERED_TOPIC, requestIdTopic],
        fromBlock: `0x${(currentBlock - 9900n).toString(16)}` as const,
        toBlock: `0x${currentBlock.toString(16)}` as const,
      }],
    });

    const ourLog = logs.find((log) => {
      const topic0 = log.topics?.[0]?.toLowerCase();
      const topic1 = log.topics?.[1]?.toLowerCase();
      return topic0 === PROOF_DELIVERED_TOPIC.toLowerCase() && topic1 === requestIdTopic.toLowerCase();
    });

    if (ourLog?.data) {
      const parsed = parseFulfillmentFromEventData(ourLog.data as string);
      if (parsed) {
        seal = parsed.seal;
        journal = parsed.journal;
        console.log(`  Found on attempt ${eventAttempt}: seal ${seal.length} bytes, journal ${journal.length} bytes`);
        break;
      }
    }

    console.log(`  Not found (attempt ${eventAttempt}/${EVENT_FETCH_RETRIES}), retrying in ${EVENT_FETCH_BACKOFF_MS / 1000}s...`);
  } catch (e: any) {
    console.log(`  Event fetch error (attempt ${eventAttempt}/${EVENT_FETCH_RETRIES}): ${e.message?.slice(0, 100)}`);
  }

  if (eventAttempt < EVENT_FETCH_RETRIES) await new Promise((r) => setTimeout(r, EVENT_FETCH_BACKOFF_MS));
}

if (!seal || !journal) {
  console.error(`\n  FAILED: Could not fetch ProofDelivered event after ${EVENT_FETCH_RETRIES} attempts.`);
  console.error("  The proof was fulfilled on-chain but we couldn't retrieve the event data.");
  console.error("  Try again with:");
  console.error(`  bun run scripts/test-boundless-submit.ts --request-id 0x${requestId.toString(16)}`);
  process.exit(1);
}

// ── Step 5: Validate seal & journal ──────────────────────────────────────
console.log("\nStep 5: Validating proof data...");

// Seal: 260 bytes = 4-byte selector + 256-byte Groth16 proof
if (seal.length !== 260) {
  console.error(`  FAIL: seal is ${seal.length} bytes (expected 260 for Groth16)`);
  console.error("  This likely means the prover delivered a non-Groth16 proof.");
  console.error("  Ensure the request uses selector 0x73c457ba (Groth16V3_0).");
  process.exit(1);
}
const selectorHex = `0x${Array.from(seal.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("")}`;
console.log(`  Seal: ${seal.length} bytes, selector: ${selectorHex}`);
if (selectorHex !== GROTH16_SELECTOR) {
  console.error(`  FAIL: selector ${selectorHex} !== ${GROTH16_SELECTOR} (Groth16V3_0)`);
  process.exit(1);
}

// Journal: 24 bytes = 6 x u32 LE
if (journal.length !== 24) {
  console.error(`  FAIL: journal is ${journal.length} bytes (expected 24)`);
  process.exit(1);
}
const jView = new DataView(journal.buffer, journal.byteOffset, journal.byteLength);
const journalFields = {
  seed: jView.getUint32(0, true),
  frame_count: jView.getUint32(4, true),
  final_score: jView.getUint32(8, true),
  final_rng_state: jView.getUint32(12, true),
  tape_checksum: jView.getUint32(16, true),
  rules_digest: jView.getUint32(20, true),
};
console.log(`  Journal: seed=0x${journalFields.seed.toString(16)}, frames=${journalFields.frame_count}, score=${journalFields.final_score}, rules=0x${journalFields.rules_digest.toString(16)}`);

if (journalFields.final_score === 0) {
  console.error("  FAIL: score is zero");
  process.exit(1);
}
if (journalFields.rules_digest !== 0x41535433) {
  console.error(`  FAIL: rules_digest 0x${journalFields.rules_digest.toString(16)} !== 0x41535433 (AST3)`);
  process.exit(1);
}
console.log("  PASS: seal and journal valid");

// ── Step 6: Adapter pipeline round-trip ──────────────────────────────────
console.log("\nStep 6: Testing adapter pipeline...");
const adapted = adaptFulfillmentToProverResponse({ seal, journal });

// Verify the adapted response reconstructs the correct 260-byte seal
const groth16 = (adapted.result!.proof.receipt as { inner: { Groth16: { seal: number[]; verifier_parameters: number[] } } }).inner.Groth16;
const reconstructedSeal = new Uint8Array(260);
const paramsBytes = new Uint8Array(32);
const paramsView = new DataView(paramsBytes.buffer);
for (let i = 0; i < groth16.verifier_parameters.length; i++) {
  paramsView.setUint32(i * 4, groth16.verifier_parameters[i], true);
}
reconstructedSeal.set(paramsBytes.slice(0, 4), 0);
reconstructedSeal.set(Uint8Array.from(groth16.seal), 4);

let sealMatch = true;
for (let i = 0; i < 260; i++) {
  if (reconstructedSeal[i] !== seal[i]) { sealMatch = false; break; }
}
if (!sealMatch) {
  console.error("  FAIL: adapter round-trip seal mismatch");
  process.exit(1);
}
console.log("  PASS: adapter round-trip seal matches original");

// Verify journal fields match
const aj = adapted.result!.proof.journal;
if (aj.final_score !== journalFields.final_score || aj.rules_digest !== journalFields.rules_digest) {
  console.error("  FAIL: adapter journal mismatch");
  process.exit(1);
}
console.log("  PASS: adapter journal fields match");

// ── Step 7: Build Soroban payload ────────────────────────────────────────
console.log("\nStep 7: Building Soroban submit_score payload...");

// Encode journal as hex (matching worker/queue/consumer.ts journalRawHex)
const journalBuf = new Uint8Array(24);
const journalView = new DataView(journalBuf.buffer);
journalView.setUint32(0, journalFields.seed >>> 0, true);
journalView.setUint32(4, journalFields.frame_count >>> 0, true);
journalView.setUint32(8, journalFields.final_score >>> 0, true);
journalView.setUint32(12, journalFields.final_rng_state >>> 0, true);
journalView.setUint32(16, journalFields.tape_checksum >>> 0, true);
journalView.setUint32(20, journalFields.rules_digest >>> 0, true);
const journalRawHex = Array.from(journalBuf).map(b => b.toString(16).padStart(2, "0")).join("");

// SHA-256 digest of the journal (for logging)
const journalDigestBytes = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new Uint8Array(
    journalRawHex.match(/.{2}/g)!.map(h => Number.parseInt(h, 16)),
  )),
);
const journalDigestHex = Array.from(journalDigestBytes).map(b => b.toString(16).padStart(2, "0")).join("");
console.log(`  Journal hex: ${journalRawHex} (${journalBuf.length} bytes)`);
console.log(`  Journal SHA-256: ${journalDigestHex}`);

// Build the Stellar seal from adapter output (same as extractGroth16SealFromProverResponse)
const stellarSeal = reconstructedSeal; // already built in step 6

const scoreClient = new ScoreContractClient({
  contractId: SCORE_CONTRACT_ID,
  rpcUrl: STELLAR_RPC_URL,
  networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
});

// Check what imageId the contract currently has stored
try {
  const storedImageId = await scoreClient.image_id();
  const storedHex = Buffer.from(storedImageId.result as unknown as Uint8Array).toString("hex");
  console.log(`  Contract imageId: 0x${storedHex}`);
  console.log(`  Our ELF imageId:  ${IMAGE_ID}`);
  if (`0x${storedHex}` !== IMAGE_ID) {
    console.error("  WARNING: imageId MISMATCH — contract needs set_image_id update");
  }
} catch (e: any) {
  console.log(`  Could not read contract imageId: ${e.message?.slice(0, 80)}`);
}

type SubmitScoreArgs = Parameters<ScoreContractClient["submit_score"]>[0];
const args: SubmitScoreArgs = {
  seal: stellarSeal as unknown as SubmitScoreArgs["seal"],
  journal_raw: journalBuf as unknown as SubmitScoreArgs["journal_raw"],
  claimant: CLAIMANT_ADDRESS,
};

const assembled = await scoreClient.submit_score(args, { simulate: false });
const built = assembled.raw?.build();
const operation = built?.operations?.[0] as
  | { func?: { toXDR(format: string): string }; auth?: Array<{ toXDR(format: string): string }> }
  | undefined;

if (!operation?.func) {
  console.error("  FAIL: bindings did not produce invokeHostFunction operation");
  process.exit(1);
}

const authEntries = Array.isArray(operation.auth) ? operation.auth : [];
const payload = {
  func: operation.func.toXDR("base64"),
  auth: authEntries.map((entry) => entry.toXDR("base64")),
};
console.log(`  Payload built: func=${payload.func.length} chars, ${payload.auth.length} auth entries`);
console.log("  PASS: Soroban payload built successfully");

// ── Step 8: Submit to Stellar via Channels relayer ───────────────────────
console.log("\nStep 8: Submitting to Stellar testnet via Channels relayer...");

const channelsClient = new ChannelsClient({
  baseUrl: RELAYER_URL,
  apiKey: RELAYER_API_KEY,
  timeout: 60_000,
});

try {
  const result = await channelsClient.submitSorobanTransaction(payload);
  const txHashStellar = result.hash?.trim() ?? "";
  const status = result.status?.trim().toLowerCase() ?? "";

  if (txHashStellar.length > 0) {
    console.log(`  Stellar tx: ${txHashStellar} (status: ${status})`);
    console.log(`  Explorer: https://stellar.expert/explorer/testnet/tx/${txHashStellar}`);
    console.log("\n=== E2E Test PASSED — Full Boundless → Stellar Pipeline ===");
    process.exit(0);
  } else {
    console.error(`  Relayer accepted but no tx hash returned (status: ${status})`);
    process.exit(1);
  }
} catch (error: any) {
  const msg = error.message?.toLowerCase() ?? "";
  // Expected contract rejections are still a valid E2E test
  if (msg.includes("score not improved") || msg.includes("scorenotimproved")) {
    console.log(`  Contract rejected: ScoreNotImproved (existing score is higher)`);
    console.log("  This is expected if the same tape was submitted before.");
    console.log("\n=== E2E Test PASSED — Pipeline valid, score already claimed ===");
    process.exit(0);
  }
  if (msg.includes("already claimed") || msg.includes("journalalreadyclaimed")) {
    console.log(`  Contract rejected: JournalAlreadyClaimed`);
    console.log("  This is expected if the same proof was submitted before.");
    console.log("\n=== E2E Test PASSED — Pipeline valid, journal already claimed ===");
    process.exit(0);
  }
  console.error(`  Relayer submission failed: ${error.message}`);
  process.exit(1);
}
