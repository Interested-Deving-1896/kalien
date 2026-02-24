/**
 * E2E test: submit a REAL game tape to Boundless on Base Mainnet.
 *
 * Usage: bun run scripts/test-boundless-submit.ts
 *
 * Secrets are loaded from scripts/.env (gitignored):
 *   BOUNDLESS_PRIVATE_KEY=0x...
 *   PINATA_JWT=...
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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

// ── Load secrets from scripts/.env ───────────────────────────────────────
const envPath = resolve(import.meta.dir, ".env");
if (!existsSync(envPath)) {
  console.error("Missing scripts/.env — copy scripts/.env.example and fill in secrets.");
  process.exit(1);
}
const envLines = readFileSync(envPath, "utf-8").split("\n");
const envVars: Record<string, string> = {};
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq > 0) envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

function requireEnv(key: string): string {
  const val = envVars[key];
  if (!val) {
    console.error(`Missing ${key} in scripts/.env`);
    process.exit(1);
  }
  return val;
}

// ── Base Mainnet deployment ──────────────────────────────────────────────
const CHAIN_ID = 8453n;
const MARKET_ADDRESS = "0xfd152dadc5183870710fe54f939eae3ab9f0fe82" as const;
const ORDER_STREAM_URL = "https://base-mainnet.boundless.network";
const RPC_URL = "https://mainnet.base.org";

const PRIVATE_KEY = requireEnv("BOUNDLESS_PRIVATE_KEY");
const PINATA_JWT = requireEnv("PINATA_JWT");
const IMAGE_URL = "https://gateway.pinata.cloud/ipfs/QmZqAjEpY6i7ZpZ3x6DLwgpxwGd4tntWKJ2Qt6a8GFmXsx";
const IMAGE_ID = "0xc2d61eb93372c44376c6c46eea2656d3c88a67eba4998456d014908d24d5e3a0";

const MAX_PRICE = 1000000000000000n; // 0.001 ETH
const FLAT_PERIOD_SEC = 300;   // 5 min prover discovery window before ramp
const RAMP_PERIOD_SEC = 600;   // 10 min for price to ramp from 0 to maxPrice
const LOCK_TIMEOUT_SEC = 2400; // 40 min from rampUpStart (10m ramp + 30m at max price)
const TIMEOUT_SEC = 5100;      // lock (40m) + 45m expiry period for secondary provers
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 90 * 60_000; // 90 minutes (covers 5m flat + 75m timeout from rampUpStart)

// Use test-medium.tape (score=90, 3980 frames — test-short has score=0 which verifier rejects)
const tapePath = resolve(import.meta.dir, "../test-fixtures/test-medium.tape");
const tapeBytes = new Uint8Array(readFileSync(tapePath));

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

console.log("=== Boundless E2E Test (Base Mainnet) ===\n");
console.log("Tape:", tapePath, `(${tapeBytes.length} bytes)`);
console.log("Wallet:", account.address);
console.log("Contract:", MARKET_ADDRESS);
console.log("Max Price:", (Number(MAX_PRICE) / 1e18).toFixed(4), "ETH");
console.log(`Auction: ${FLAT_PERIOD_SEC/60}m flat → ${RAMP_PERIOD_SEC/60}m ramp → ${LOCK_TIMEOUT_SEC/60}m lock → ${TIMEOUT_SEC/60}m expiry`);
console.log("");

// ── Step 0: Encode stdin + upload to IPFS ────────────────────────────────
console.log("Step 0: Encoding stdin & uploading to IPFS...");
const stdinBytes = encodeStdin(tapeBytes);
console.log(`  Stdin: ${stdinBytes.length} bytes`);

// Upload to Pinata
const hashBuffer = await crypto.subtle.digest("SHA-256", stdinBytes);
const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
const filename = `${hashHex}.input`;

const formData = new FormData();
formData.append("file", new Blob([stdinBytes], { type: "application/octet-stream" }), filename);
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

// For URL input, the data field is the UTF-8 encoded URL as hex
const stdinUrlHex = `0x${Array.from(new TextEncoder().encode(stdinUrl)).map(b => b.toString(16).padStart(2, "0")).join("")}` as Hex;

// ── Step 1: Build request with URL input ─────────────────────────────────
const nonce = Date.now();
const requestId = (BigInt(account.address) << 32n) | BigInt(nonce >>> 0);
const nowSec = BigInt(Math.floor(Date.now() / 1000));
const rampUpStart = nowSec + BigInt(FLAT_PERIOD_SEC);
const timeoutSec = TIMEOUT_SEC;

const proofRequest: ProofRequest = {
  id: requestId,
  requirements: {
    callback: {
      addr: "0x0000000000000000000000000000000000000000",
      gasLimit: 0n,
    },
    predicate: {
      predicateType: 1, // PrefixMatch — match any journal from this image
      data: IMAGE_ID,
    },
    selector: "0x00000000",
  },
  imageUrl: IMAGE_URL,
  input: {
    inputType: 1, // Url
    data: stdinUrlHex,
  },
  offer: {
    minPrice: 0n,              // Reverse Dutch auction: start at zero
    maxPrice: MAX_PRICE,       // Ramp up to ceiling
    rampUpStart,               // Flat period before ramp begins
    rampUpPeriod: RAMP_PERIOD_SEC,  // Seconds for 0 -> maxPrice
    lockTimeout: LOCK_TIMEOUT_SEC,  // Prover deadline from rampUpStart
    timeout: timeoutSec,       // Total expiry from rampUpStart
    lockCollateral: 0n,
  },
};

// ── Step 2: Sign + submit on-chain ───────────────────────────────────────
console.log("\nStep 1: Signing & submitting on-chain...");
const t0 = Date.now();

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

// ── Step 3: Submit to order stream ───────────────────────────────────────
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

// ── Step 4: Poll for fulfillment ─────────────────────────────────────────
console.log("\nStep 2: Polling for fulfillment (may take 20-30 min on mainnet)...");
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

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
      console.log(`\n  Total time: ${totalSec}s`);

      try {
        const currentBlock = await publicClient.getBlockNumber();
        const logs = await publicClient.getLogs({
          address: MARKET_ADDRESS,
          event: {
            type: "event",
            name: "RequestFulfilled",
            inputs: [
              { name: "id", type: "uint256", indexed: true },
              { name: "fulfillment", type: "bytes", indexed: false },
            ],
          },
          args: { id: requestId },
          fromBlock: currentBlock - 50000n,
          toBlock: currentBlock,
        });

        if (logs.length > 0 && logs[0].args.fulfillment) {
          const fulfillmentHex = logs[0].args.fulfillment;
          const clean = fulfillmentHex.slice(2);
          const bytes = new Uint8Array(clean.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
          }
          const view = new DataView(bytes.buffer);
          const readU256 = (off: number) => {
            let r = 0n;
            for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(view.getUint8(off + i));
            return r;
          };
          const sealOffset = Number(readU256(32));
          const journalOffset = Number(readU256(64));
          const sealLen = Number(readU256(sealOffset));
          const seal = bytes.slice(sealOffset + 32, sealOffset + 32 + sealLen);
          const journalLen = Number(readU256(journalOffset));
          const journal = bytes.slice(journalOffset + 32, journalOffset + 32 + journalLen);

          console.log(`  Seal: ${seal.length} bytes`);
          console.log(`  Journal: ${journal.length} bytes`);

          const adapted = adaptFulfillmentToProverResponse({ seal, journal });
          console.log(`  Adapter output:`, JSON.stringify(adapted).slice(0, 400));
        }
      } catch (e: any) {
        console.log(`  Event fetch error: ${e.message}`);
      }

      console.log("\n=== E2E Test PASSED ===");
      process.exit(0);
    }

    console.log("running");
  } catch (e: any) {
    console.log(`error: ${e.message?.slice(0, 80)}`);
  }

  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nTimed out after ${totalSec}s (${attempt} polls).`);
console.log("Request ID:", requestIdHex);
