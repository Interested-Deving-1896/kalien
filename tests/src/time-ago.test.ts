import { describe, expect, it } from "bun:test";
import { timeAgo } from "../../src/time";

describe("timeAgo", () => {
  it("returns 'invalid date' for invalid input", () => {
    expect(timeAgo("not-a-date")).toBe("invalid date");
    expect(timeAgo(NaN)).toBe("invalid date");
  });

  it("returns 'just now' for future timestamps", () => {
    expect(timeAgo(Date.now() + 60_000)).toBe("just now");
  });

  it("returns '1s ago' for 0ms diff", () => {
    expect(timeAgo(Date.now())).toBe("1s ago");
  });

  it("returns seconds ago for sub-minute diffs", () => {
    expect(timeAgo(Date.now() - 30_000)).toBe("30s ago");
  });

  it("returns '1 min ago' for one minute", () => {
    expect(timeAgo(Date.now() - 60_000)).toBe("1 min ago");
  });

  it("returns minutes ago for multi-minute diffs", () => {
    expect(timeAgo(Date.now() - 5 * 60_000)).toBe("5 min ago");
  });

  it("returns '1 hour ago' for one hour", () => {
    expect(timeAgo(Date.now() - 60 * 60_000)).toBe("1 hour ago");
  });

  it("returns hours ago for multi-hour diffs", () => {
    expect(timeAgo(Date.now() - 3 * 60 * 60_000)).toBe("3 hours ago");
  });

  it("returns '1 day ago' for one day", () => {
    expect(timeAgo(Date.now() - 24 * 60 * 60_000)).toBe("1 day ago");
  });

  it("returns days ago for multi-day diffs", () => {
    expect(timeAgo(Date.now() - 7 * 24 * 60 * 60_000)).toBe("7 days ago");
  });
});
