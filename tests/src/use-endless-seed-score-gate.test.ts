import { afterEach, describe, expect, it } from "bun:test";
import { commitFetchedSeedScore } from "../../src/hooks/useEndlessSeedScoreGate";

type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function makeWindow(
  initial: Record<string, string> = {},
): Window & { sessionStorage: SessionStorageLike } {
  const store = new Map(Object.entries(initial));
  return {
    sessionStorage: {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
    },
  } as Window & { sessionStorage: SessionStorageLike };
}

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow;
  }
});

describe("commitFetchedSeedScore", () => {
  it("preserves cached seed best when the contract read fails", () => {
    const storageKey = "kalien:endless-seed-best:test";
    (globalThis as Record<string, unknown>).window = makeWindow({
      [storageKey]: JSON.stringify({ "7": 120 }),
    });

    const cache = new Map<number, number>([[7, 120]]);
    const readySeedIds = new Set<number>([7]);

    const result = commitFetchedSeedScore(storageKey, cache, readySeedIds, 7, 0, null);

    expect(result).toBeNull();
    expect(cache.get(7)).toBe(120);
    expect(readySeedIds.has(7)).toBe(true);
    expect(globalThis.window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify({ "7": 120 }));
  });

  it("stores the refreshed on-chain best when the read succeeds", () => {
    const storageKey = "kalien:endless-seed-best:test";
    (globalThis as Record<string, unknown>).window = makeWindow();

    const cache = new Map<number, number>();
    const readySeedIds = new Set<number>();

    const result = commitFetchedSeedScore(storageKey, cache, readySeedIds, 9, 345, 345);

    expect(result).toBe(345);
    expect(cache.get(9)).toBe(345);
    expect(readySeedIds.has(9)).toBe(true);
    expect(globalThis.window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify({ "9": 345 }));
  });
});
