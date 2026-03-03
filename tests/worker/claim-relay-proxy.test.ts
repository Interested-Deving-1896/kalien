import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";

let mockSubmitSorobanTransaction: ReturnType<typeof mock>;
let mockSubmitTransaction: ReturnType<typeof mock>;

class MockPluginExecutionError extends Error {
  readonly category: string;
  readonly errorDetails?: unknown;

  constructor(message: string, errorDetails?: unknown) {
    super(message);
    this.name = "PluginExecutionError";
    this.category = "execution";
    this.errorDetails = errorDetails;
  }
}

class MockPluginTransportError extends Error {
  readonly category: string;
  readonly statusCode?: number;
  readonly errorDetails?: unknown;

  constructor(message: string, statusCode?: number, errorDetails?: unknown) {
    super(message);
    this.name = "PluginTransportError";
    this.category = "transport";
    this.statusCode = statusCode;
    this.errorDetails = errorDetails;
  }
}

mock.module("@openzeppelin/relayer-plugin-channels/dist/client", () => {
  mockSubmitSorobanTransaction = mock(async () => ({
    hash: "soroban-hash",
    status: "submitted",
  }));
  mockSubmitTransaction = mock(async () => ({
    hash: "signed-hash",
    status: "submitted",
  }));

  return {
    ChannelsClient: class MockChannelsClient {
      submitSorobanTransaction(payload: unknown) {
        return mockSubmitSorobanTransaction(payload);
      }

      submitTransaction(payload: unknown) {
        return mockSubmitTransaction(payload);
      }
    },
    PluginExecutionError: MockPluginExecutionError,
    PluginTransportError: MockPluginTransportError,
  };
});

const { submitRelayProxy } = await import("../../worker/claim/direct");

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    SCORE_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
    RELAYER_URL: "https://channels.openzeppelin.com/relay",
    RELAYER_API_KEY: "test-api-key",
    ...overrides,
  } as WorkerEnv;
}

describe("submitRelayProxy onchain_failed classification", () => {
  beforeEach(() => {
    mockSubmitSorobanTransaction.mockReset();
    mockSubmitTransaction.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  it("retries soroban submissions for txInsufficientFee resultCode", async () => {
    mockSubmitSorobanTransaction.mockRejectedValueOnce(
      new MockPluginExecutionError("submission failed", {
        code: "ONCHAIN_FAILED",
        details: {
          resultCode: "txInsufficientFee",
        },
      }),
    );

    const result = await submitRelayProxy(makeEnv(), {
      kind: "soroban",
      func: "AAAA",
      auth: [],
    });

    expect(result.type).toBe("retry");
  });

  it("retries signed submissions when fee code appears in details.reason", async () => {
    mockSubmitTransaction.mockRejectedValueOnce(
      new MockPluginExecutionError("provider failed", {
        code: "onchain_failed",
        details: {
          reason: "Specific XDR reason: txFeeBumpInnerFailed",
        },
      }),
    );

    const result = await submitRelayProxy(makeEnv(), {
      kind: "xdr",
      xdr: "AAAA",
    });

    expect(result.type).toBe("retry");
  });

  it("keeps non-fee onchain failures fatal", async () => {
    mockSubmitTransaction.mockRejectedValueOnce(
      new MockPluginExecutionError("on-chain rejected", {
        code: "ONCHAIN_FAILED",
        details: {
          resultCode: "txBadAuth",
        },
      }),
    );

    const result = await submitRelayProxy(makeEnv(), {
      kind: "xdr",
      xdr: "AAAA",
    });

    expect(result.type).toBe("fatal");
  });
});
