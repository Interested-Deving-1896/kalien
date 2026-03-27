import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { packJournalRaw } from "../../shared/stellar/journal";

const actualViem = await import("viem");

type ReadContractArgs = {
  functionName: string;
  args?: unknown[];
};

type RequestArgs = {
  method: string;
  params?: Array<{
    fromBlock?: string;
    toBlock?: string;
    topics?: string[];
  }>;
};

let getBlockNumberValue = 0n;
let readContractImpl: (args: ReadContractArgs) => Promise<unknown> = async () => false;
let requestImpl: (args: RequestArgs) => Promise<unknown> = async () => [];
const requestCalls: RequestArgs[] = [];

mock.module("viem", () => ({
  ...actualViem,
  createPublicClient: () => ({
    readContract: (args: ReadContractArgs) => readContractImpl(args),
    getBlockNumber: async () => getBlockNumberValue,
    request: async (args: RequestArgs) => {
      requestCalls.push(args);
      return requestImpl(args);
    },
  }),
  createWalletClient: () => ({}),
  defineChain: (chain: unknown) => chain,
  http: (url: string) => url,
}));

mock.module("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    address: "0x1111111111111111111111111111111111111111",
  }),
}));

const { fetchProofDeliveredLog, fetchProofDeliveredLogFromTxReceipt } = await import(
  "../../worker/boundless/sdk/client"
);
const { fetchBoundlessCycles } = await import("../../worker/boundless/sdk/client.ts?suite=real");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  getBlockNumberValue = 0n;
  readContractImpl = async () => false;
  requestImpl = async () => [];
  requestCalls.length = 0;
});

function encodeProofDeliveredData(journalHex: `0x${string}`, sealHex: `0x${string}`): `0x${string}` {
  return actualViem.encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "requestDigest", type: "bytes32" },
          { name: "claimDigest", type: "bytes32" },
          { name: "fulfillmentDataType", type: "uint8" },
          { name: "fulfillmentData", type: "bytes" },
          { name: "seal", type: "bytes" },
        ],
      },
    ],
    [
      {
        id: 1n,
        requestDigest: `0x${"00".repeat(32)}`,
        claimDigest: `0x${"11".repeat(32)}`,
        fulfillmentDataType: 0,
        fulfillmentData: journalHex,
        seal: sealHex,
      },
    ],
  );
}

describe("Boundless fulfillment log paging", () => {
  it("pages fulfillment log lookup into RPC-safe windows", async () => {
    const requestId = 12345n;
    const requestIdTopic = `0x${requestId.toString(16).padStart(64, "0")}`;
    const proofDeliveredTopic =
      "0xaf1db8f86d3f32029a484ff54c7ac1d7ef8f038ab050fc065af9e82eb9b850ca";
    const proverAddress = "0x2222222222222222222222222222222222222222";
    const proverTopic = `0x${proverAddress.slice(2).padStart(64, "0")}`;

    const journalBytes = packJournalRaw({
      seed_id: 7,
      seed: 42,
      frame_count: 120,
      final_score: 777,
      claimant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    });
    const sealHex = `0x${"ab".repeat(260)}` as `0x${string}`;
    const journalHex = actualViem.toHex(journalBytes) as `0x${string}`;
    const encodedData = encodeProofDeliveredData(journalHex, sealHex);

    requestImpl = async ({ method, params }) => {
      expect(method).toBe("eth_getLogs");
      const range = params?.[0];
      if (range?.fromBlock === "0x68" && range?.toBlock === "0x71") {
        return [
          {
            topics: [proofDeliveredTopic, requestIdTopic, proverTopic],
            data: encodedData,
            transactionHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
          },
        ];
      }
      return [];
    };

    const result = await fetchProofDeliveredLog(
      {
        request: async (args: RequestArgs) => {
          requestCalls.push(args);
          return requestImpl(args);
        },
      },
      "0x5555555555555555555555555555555555555555",
      requestId,
      100n,
      123n,
    );

    expect(result).toMatchObject({
      topics: [proofDeliveredTopic, requestIdTopic, proverTopic],
      transactionHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    });
    expect(requestCalls).toHaveLength(2);
    expect(requestCalls[0]?.params?.[0]).toMatchObject({
      fromBlock: "0x72",
      toBlock: "0x7b",
    });
    expect(requestCalls[1]?.params?.[0]).toMatchObject({
      fromBlock: "0x68",
      toBlock: "0x71",
    });

    for (const call of requestCalls) {
      const range = call.params?.[0];
      expect(range).toBeDefined();
      const from = BigInt(range?.fromBlock ?? "0x0");
      const to = BigInt(range?.toBlock ?? "0x0");
      expect(to - from + 1n).toBeLessThanOrEqual(10n);
    }
  });
});

describe("Boundless fulfillment receipt lookup", () => {
  it("extracts the proof log from a fulfillment transaction receipt", async () => {
    const requestId = 12345n;
    const requestIdTopic = `0x${requestId.toString(16).padStart(64, "0")}`;
    const proofDeliveredTopic =
      "0xaf1db8f86d3f32029a484ff54c7ac1d7ef8f038ab050fc065af9e82eb9b850ca";
    const proverAddress = "0x2222222222222222222222222222222222222222";
    const proverTopic = `0x${proverAddress.slice(2).padStart(64, "0")}`;
    const txHash = "0x3333333333333333333333333333333333333333333333333333333333333333" as const;

    const result = await fetchProofDeliveredLogFromTxReceipt(
      {
        request: async () => ({
          logs: [
            {
              topics: ["0xdeadbeef", requestIdTopic],
              data: "0x",
              transactionHash: txHash,
            },
            {
              topics: [proofDeliveredTopic, requestIdTopic, proverTopic],
              data: "0x1234",
              transactionHash: txHash,
            },
          ],
        }),
      },
      requestId,
      txHash,
    );

    expect(result).toMatchObject({
      topics: [proofDeliveredTopic, requestIdTopic, proverTopic],
      data: "0x1234",
      transactionHash: txHash,
    });
  });
});

describe("fetchBoundlessCycles", () => {
  it("parses object payloads from the Boundless indexer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      new Response(
        JSON.stringify({
          program_cycles: "49183188",
          total_cycles: "51380224",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("8453", "0xabc");
      expect(result).toEqual({
        programCycles: 49183188,
        totalCycles: 51380224,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to Explorer API when primary indexer responds non-200", async () => {
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.url;
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response(
        JSON.stringify({
          program_cycles: "391",
          total_cycles: "422",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("8453", "0x123");
      expect(result).toEqual({
        programCycles: 391,
        totalCycles: 422,
      });
      expect(calledUrls[0]).toBe("https://d2mdvlnmyov1e1.cloudfront.net/v1/market/requests/0x123");
      expect(calledUrls[1]).toBe("https://explorer.boundless.network/api/orders/0x123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses Explorer API even when chain has no configured indexer URL", async () => {
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.url;
      calledUrls.push(url);
      return new Response(
        JSON.stringify({
          program_cycles: "111",
          total_cycles: "222",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("11155111", "0x987");
      expect(result).toEqual({
        programCycles: 111,
        totalCycles: 222,
      });
      expect(calledUrls).toEqual(["https://explorer.boundless.network/api/orders/0x987"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null cycles when all sources fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("8453", "0xdead");
      expect(result).toEqual({
        programCycles: null,
        totalCycles: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
