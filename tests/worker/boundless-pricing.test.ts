import { describe, expect, it, mock, beforeEach } from "bun:test";

// ── usdToWei tests (pure math, no mocking needed) ──────────────────────────

// Import the real usdToWei directly — it's a pure function
import { usdToWei } from "../../worker/boundless/pricing";

describe("usdToWei", () => {
  it("converts $1 at $2000/ETH to 0.0005 ETH", () => {
    const wei = usdToWei(1, 2000);
    // $1 / $2000/ETH = 0.0005 ETH = 5e14 wei
    expect(wei).toBe(500_000_000_000_000n);
  });

  it("converts $0.02 at $1900/ETH correctly", () => {
    const wei = usdToWei(0.02, 1900);
    // $0.02 / $1900 = 0.00001052631... ETH ≈ 10_526_315_789_473n wei
    // Verify within ±1 wei of expected (integer division truncation)
    const expected = (20_000n * 10n ** 18n) / 1_900_000_000n;
    expect(wei).toBe(expected);
  });

  it("converts $0.0002 at $1900/ETH (auction floor)", () => {
    const wei = usdToWei(0.0002, 1900);
    const expected = (200n * 10n ** 18n) / 1_900_000_000n;
    expect(wei).toBe(expected);
  });

  it("returns 0 for $0", () => {
    expect(usdToWei(0, 2000)).toBe(0n);
  });

  it("handles very high ETH price ($100,000)", () => {
    const wei = usdToWei(0.02, 100_000);
    // $0.02 / $100,000 = 2e-7 ETH = 200_000_000_000 wei
    const expected = (20_000n * 10n ** 18n) / 100_000_000_000n;
    expect(wei).toBe(expected);
    expect(wei).toBeGreaterThan(0n);
  });

  it("handles very low ETH price ($100)", () => {
    const wei = usdToWei(0.02, 100);
    // $0.02 / $100 = 0.0002 ETH = 200_000_000_000_000 wei
    const expected = (20_000n * 10n ** 18n) / 100_000_000n;
    expect(wei).toBe(expected);
  });

  it("maintains precision — maxPrice > minPrice for same ETH price", () => {
    const ethPrice = 1896.42;
    const min = usdToWei(0.0002, ethPrice);
    const max = usdToWei(0.02, ethPrice);
    expect(max).toBeGreaterThan(min);
    // max should be ~100x min (ratio of 0.02 / 0.0002)
    // Allow ±1 for rounding
    expect(max / min).toBe(100n);
  });

  it("scales linearly — doubling USD doubles wei", () => {
    const ethPrice = 2500;
    const single = usdToWei(0.01, ethPrice);
    const double = usdToWei(0.02, ethPrice);
    expect(double).toBe(single * 2n);
  });

  it("uses integer arithmetic to avoid float precision issues", () => {
    // 0.1 + 0.2 !== 0.3 in floats, but our micro-scaling should handle it
    const a = usdToWei(0.1, 3000);
    const b = usdToWei(0.2, 3000);
    const c = usdToWei(0.3, 3000);
    // a + b should equal c (within ±1 wei for rounding)
    const diff = (a + b) - c;
    expect(diff >= -1n && diff <= 1n).toBe(true);
  });
});

// ── fetchEthPriceUsd tests (mocked RPC) ─────────────────────────────────────

// Mock the viem module to intercept createPublicClient
let mockReadContract: ReturnType<typeof mock>;

mock.module("viem", () => {
  mockReadContract = mock();
  return {
    createPublicClient: () => ({
      readContract: mockReadContract,
    }),
    defineChain: (config: unknown) => config,
    http: (url: string) => url,
  };
});

// Import after mock is set up
const { fetchEthPriceUsd, resetEthPriceCache } = await import("../../worker/boundless/pricing");

describe("fetchEthPriceUsd", () => {
  beforeEach(() => {
    mockReadContract!.mockReset();
    resetEthPriceCache();
  });

  it("returns correct price from Chainlink response ($1,900)", async () => {
    // Chainlink returns 8-decimal fixed point: 190000000000 = $1,900.00
    mockReadContract!.mockResolvedValueOnce([0n, 190_000_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 8453);
    expect(price).toBe(1900);
  });

  it("returns fractional prices ($2,456.78)", async () => {
    mockReadContract!.mockResolvedValueOnce([0n, 245_678_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 8453);
    expect(price).toBe(2456.78);
  });

  it("works with Base Sepolia chainId", async () => {
    mockReadContract!.mockResolvedValueOnce([0n, 200_000_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 84532);
    expect(price).toBe(2000);
  });

  it("works with Ethereum Sepolia chainId", async () => {
    mockReadContract!.mockResolvedValueOnce([0n, 150_000_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 11155111);
    expect(price).toBe(1500);
  });

  it("throws for unsupported chainId", async () => {
    await expect(fetchEthPriceUsd("https://rpc.example.com", 999)).rejects.toThrow(
      "no Chainlink ETH/USD feed configured for chainId 999",
    );
  });

  it("throws when Chainlink returns zero price", async () => {
    mockReadContract!.mockResolvedValueOnce([0n, 0n, 0n, 0n, 0n]);
    await expect(fetchEthPriceUsd("https://rpc.example.com", 8453)).rejects.toThrow(
      "Chainlink returned invalid ETH price: 0",
    );
  });

  it("throws when Chainlink returns negative price", async () => {
    mockReadContract!.mockResolvedValueOnce([0n, -100_000_000n, 0n, 0n, 0n]);
    await expect(fetchEthPriceUsd("https://rpc.example.com", 8453)).rejects.toThrow(
      "Chainlink returned invalid ETH price",
    );
  });

  it("propagates RPC errors", async () => {
    mockReadContract!.mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(fetchEthPriceUsd("https://rpc.example.com", 8453)).rejects.toThrow("RPC timeout");
  });
});

// ── resolveBoundlessConfig tests (USD pricing fields) ───────────────────────

import { resolveBoundlessConfig } from "../../worker/boundless/config";
import type { WorkerEnv } from "../../worker/env";

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    BOUNDLESS_RPC_URL: "https://base-mainnet.public.blastapi.io",
    BOUNDLESS_PRIVATE_KEY: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    BOUNDLESS_IMAGE_URL: "https://gateway.pinata.cloud/ipfs/QmTest",
    BOUNDLESS_IMAGE_ID: "0xb7b997df521f1caee0fa5004f94e2623dce78aabf914f350c476ca2c19832e8f",
    ...overrides,
  } as WorkerEnv;
}

describe("resolveBoundlessConfig", () => {
  it("returns null when required vars are missing", () => {
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_RPC_URL: "" }))).toBeNull();
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_PRIVATE_KEY: undefined }))).toBeNull();
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_IMAGE_URL: "" }))).toBeNull();
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_IMAGE_ID: undefined }))).toBeNull();
  });

  it("returns config with USD pricing defaults ($0.02 / $0.0002)", () => {
    const config = resolveBoundlessConfig(makeEnv());
    expect(config).not.toBeNull();
    expect(config!.maxPriceUsd).toBe(0.02);
    expect(config!.minPriceUsd).toBe(0.0002);
  });

  it("reads custom USD pricing from env vars", () => {
    const config = resolveBoundlessConfig(
      makeEnv({ BOUNDLESS_MAX_PRICE_USD: "0.05", BOUNDLESS_MIN_PRICE_USD: "0.001" }),
    );
    expect(config!.maxPriceUsd).toBe(0.05);
    expect(config!.minPriceUsd).toBe(0.001);
  });

  it("defaults to Base Mainnet auction timing", () => {
    const config = resolveBoundlessConfig(makeEnv())!;
    expect(config.flatPeriodSec).toBe(60);     // 1 min
    expect(config.rampPeriodSec).toBe(660);    // 11 min
    expect(config.lockTimeoutSec).toBe(1740);  // 29 min
    expect(config.timeoutSec).toBe(3540);      // 59 min
  });

  it("defaults to Base Mainnet chain config", () => {
    const config = resolveBoundlessConfig(makeEnv())!;
    expect(config.chainId).toBe(8453n);
    expect(config.marketAddress).toBe("0xfd152dadc5183870710fe54f939eae3ab9f0fe82");
    expect(config.orderStreamUrl).toBe("https://base-mainnet.boundless.network");
  });

  it("normalizes private key with 0x prefix", () => {
    const config = resolveBoundlessConfig(
      makeEnv({ BOUNDLESS_PRIVATE_KEY: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    )!;
    expect(config.privateKey.startsWith("0x")).toBe(true);
  });

  it("normalizes image ID with 0x prefix", () => {
    const config = resolveBoundlessConfig(
      makeEnv({ BOUNDLESS_IMAGE_ID: "b7b997df521f1caee0fa5004f94e2623dce78aabf914f350c476ca2c19832e8f" }),
    )!;
    expect(config.imageId.startsWith("0x")).toBe(true);
  });
});

// ── Integration: usdToWei with realistic config values ──────────────────────

describe("usdToWei integration with config defaults", () => {
  it("produces reasonable wei values for default config at current ETH prices", () => {
    const ethPrices = [1500, 1900, 2500, 5000, 10000];
    for (const ethPrice of ethPrices) {
      const maxWei = usdToWei(0.02, ethPrice);
      const minWei = usdToWei(0.0002, ethPrice);

      // Max should always be positive
      expect(maxWei).toBeGreaterThan(0n);
      // Min should always be positive
      expect(minWei).toBeGreaterThan(0n);
      // Max > min
      expect(maxWei).toBeGreaterThan(minWei);
      // Max should be less than 1 ETH (sanity check: $0.02 << 1 ETH)
      expect(maxWei).toBeLessThan(10n ** 18n);
      // Min should be less than max
      expect(minWei).toBeLessThan(maxWei);
    }
  });
});
