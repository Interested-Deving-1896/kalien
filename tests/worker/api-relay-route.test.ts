import { afterAll, describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";

let mockSubmitRelayProxy: ReturnType<typeof mock>;

mock.module("../../worker/claim/direct", () => {
  mockSubmitRelayProxy = mock(async () => ({
    type: "success" as const,
    txHash: "tx-default",
  }));
  return {
    submitRelayProxy: mockSubmitRelayProxy,
  };
});

const { createRelayRouter } = await import("../../worker/api/routes-relay");

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    RELAYER_URL: "https://channels.openzeppelin.com",
    RELAYER_API_KEY: "test-key",
    SCORE_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
    ...overrides,
  } as WorkerEnv;
}

describe("/api/relay response contract", () => {
  afterAll(() => {
    mock.restore();
  });

  it("returns success payload with hash and status", async () => {
    mockSubmitRelayProxy.mockResolvedValueOnce({
      type: "success",
      txHash: "tx-123",
    });

    const app = createRelayRouter();
    const response = await app.fetch(
      new Request("https://example.com/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.1",
        },
        body: JSON.stringify({ func: "AAAA", auth: [] }),
      }),
      makeEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      success: true,
      data: { hash: "tx-123", status: "submitted" },
    });
  });

  it("returns retryable error payload with retryable=true", async () => {
    mockSubmitRelayProxy.mockResolvedValueOnce({
      type: "retry",
      message: "temporary relay issue",
      errorDetail: "code: ONCHAIN_FAILED\ndetails here",
    });

    const app = createRelayRouter();
    const response = await app.fetch(
      new Request("https://example.com/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.2",
        },
        body: JSON.stringify({ func: "AAAA", auth: [] }),
      }),
      makeEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toEqual({
      success: false,
      error: "temporary relay issue",
      message: "temporary relay issue",
      code: "ONCHAIN_FAILED",
      errorCode: "ONCHAIN_FAILED",
      retryable: true,
      data: { detail: "code: ONCHAIN_FAILED\ndetails here" },
    });
  });

  it("returns fatal error payload with retryable=false", async () => {
    mockSubmitRelayProxy.mockResolvedValueOnce({
      type: "fatal",
      message: "invalid request",
    });

    const app = createRelayRouter();
    const response = await app.fetch(
      new Request("https://example.com/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.3",
        },
        body: JSON.stringify({ xdr: "AAAA" }),
      }),
      makeEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toEqual({
      success: false,
      error: "invalid request",
      message: "invalid request",
      retryable: false,
      data: undefined,
    });
  });
});
