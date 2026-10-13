import { describe, expect, it } from "bun:test";
import { adjustedInterval, holmAdjust, SRM_THRESHOLD, srmPValue } from "../src/index.ts";

describe("srmPValue", () => {
  it("5000 vs 5200 at 50/50 gives p = 0.04767 (healthy)", () => {
    const p = srmPValue([5000, 5200], [0.5, 0.5]);
    expect(p).toBeCloseTo(0.0476704, 6);
    expect(p! > SRM_THRESHOLD).toBe(true);
  });
  it("returns null below 8 units per variation", () => expect(srmPValue([7, 8], [1, 1])).toBeNull());
  it("is 1 for an exact match", () => expect(srmPValue([300, 600], [1, 2])).toBeCloseTo(1, 12));
});

describe("holmAdjust", () => {
  it("adjusts in input order and is monotone in rank", () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03, 0.005]);
    expect(adjusted.map((p) => +p.toFixed(12))).toEqual([0.03, 0.06, 0.06, 0.02]);
  });
  it("caps at 1 and never lowers a p-value", () => {
    const raw = [0.9, 0.2, 0.6];
    const adjusted = holmAdjust(raw);
    expect(Math.max(...adjusted)).toBe(1);
    adjusted.forEach((p, i) => expect(p).toBeGreaterThanOrEqual(raw[i]!));
  });
});

describe("adjustedInterval", () => {
  it("with the unadjusted p reproduces the normal CI", () => {
    const [lo, hi] = adjustedInterval(0.027878, 0.1, 0.05);
    expect(lo).toBeCloseTo(0.01087, 4);
    expect(hi).toBeCloseTo(0.18913, 4);
  });
  it("is unbounded when the adjusted p is 1", () => expect(adjustedInterval(1, 0.1, 0.05)).toEqual([-Infinity, Infinity]));
});
