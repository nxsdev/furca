import { describe, expect, it } from "bun:test";
import { cumulative, summarize, unitVariance } from "../src/index.ts";

describe("summarize / unitVariance", () => {
  it("proportion uses p(1−p)", () => {
    const m = { n: 10, sum: 3, sumSquares: 3 };
    expect(summarize("proportion", m)).toEqual({ n: 10, total: 3, mean: 0.3 });
    expect(unitVariance("proportion", m)).toBeCloseTo(0.21, 12);
  });
  it("mean uses the n−1 sample variance", () => expect(unitVariance("mean", { n: 3, sum: 6, sumSquares: 14 })).toBeCloseTo(1, 12));
  it("ratio mean is the ratio of sums", () =>
    expect(summarize("ratio", { n: 2, sum: 3, sumSquares: 5, denominatorSum: 4 }).mean).toBe(0.75));
});

describe("cumulative", () => {
  it("sorts by date and keeps running sums per variation", () => {
    const day = (date: string, n: number) => ({ date, moments: [{ n, sum: n, sumSquares: n, preSum: 1 }] });
    const out = cumulative([day("2026-10-02", 5), day("2026-10-01", 3)]);
    expect(out.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(out[1]!.moments[0]).toEqual({ n: 8, sum: 8, sumSquares: 8, preSum: 2 });
    expect(out[0]!.moments[0]!.n).toBe(3);
  });
});
