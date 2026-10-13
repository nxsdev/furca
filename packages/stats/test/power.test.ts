import { describe, expect, it } from "bun:test";
import { daysToReach, mdeForSampleSize, sampleSizePerVariation } from "../src/index.ts";

const conversion = { kind: "proportion", baselineMean: 0.1, alpha: 0.05, variations: 2 } as const;

describe("sampleSizePerVariation", () => {
  // expected values: smallest N with exact two-sided power ≥ 0.8, found by bisection
  it("10% baseline, 10% MDE needs 15612 per variation", () =>
    expect(sampleSizePerVariation({ ...conversion, mde: 0.1 })).toBe(15612));
  it("mean metric uses baselineStdDev", () =>
    expect(sampleSizePerVariation({ kind: "mean", baselineMean: 50, baselineStdDev: 30, alpha: 0.05, mde: 0.05 })).toBe(2377));
  it("returns null without a std dev for mean metrics", () =>
    expect(sampleSizePerVariation({ kind: "mean", baselineMean: 50, alpha: 0.05, mde: 0.05 })).toBeNull());
});

describe("mdeForSampleSize", () => {
  it("round-trips with sampleSizePerVariation", () => {
    const n = sampleSizePerVariation({ ...conversion, mde: 0.1 })!;
    const mde = mdeForSampleSize({ ...conversion, usersPerVariation: n })!;
    expect(mde).toBeLessThanOrEqual(0.1);
    expect(mde).toBeCloseTo(0.1, 4);
  });
  it("returns null when N ≤ k²σ²/μ²", () => expect(mdeForSampleSize({ ...conversion, usersPerVariation: 50 })).toBeNull());
});

describe("daysToReach", () => {
  it("divides total users by covered daily traffic, rounding up", () =>
    expect(daysToReach({ usersPerVariation: 15612, variations: 2, dailyTraffic: 1000, coverage: 0.5 })).toBe(63));
  it("returns null without traffic", () =>
    expect(daysToReach({ usersPerVariation: 100, variations: 2, dailyTraffic: 0, coverage: 1 })).toBeNull());
});
