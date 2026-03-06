import { afterEach, describe, expect, it } from "bun:test";
import { serializeTape } from "../../src/game/tape";
import { fetchProofTape, ProofApiError } from "../../src/proof/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchProofTape", () => {
  it("returns tape bytes and filename for octet-stream responses", async () => {
    const tapeBytes = serializeTape(0x1234abcd, new Uint8Array([1, 2, 3, 4]), 9001);

    globalThis.fetch = (async () =>
      new Response(tapeBytes, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="job-123.tape"',
        },
      })) as typeof fetch;

    const result = await fetchProofTape("job-123");
    expect(result.filename).toBe("job-123.tape");
    expect(result.bytes).toEqual(tapeBytes);
  });

  it("rejects html responses instead of treating them as tape bytes", async () => {
    globalThis.fetch = (async () =>
      new Response("<!doctype html><html><body>spa shell</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      })) as typeof fetch;

    try {
      await fetchProofTape("job-html");
      throw new Error("expected fetchProofTape to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProofApiError);
      expect((error as Error).message).toBe("expected tape bytes but received HTML");
    }
  });
});
