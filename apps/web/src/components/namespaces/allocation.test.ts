import { describe, expect, it } from "bun:test";
import { firstFreeSlice, freeRanges, freeShare, overlaps } from "./allocation";

describe("namespace allocation", () => {
  const taken = [
    { start: 0.5, end: 0.8 },
    { start: 0, end: 0.2 },
    { start: 0.1, end: 0.3 },
  ];

  it("finds the gaps between overlapping and unsorted slices", () => {
    expect(freeRanges(taken)).toEqual([
      { start: 0.3, end: 0.5 },
      { start: 0.8, end: 1 },
    ]);
    expect(freeShare(taken)).toBeCloseTo(0.4);
  });

  it("uses the first gap wide enough for the requested width, else the first gap, else nothing", () => {
    expect(firstFreeSlice(taken, 0.15)).toEqual({ start: 0.3, end: 0.45 });
    expect(firstFreeSlice(taken, 0.2)).toEqual({ start: 0.3, end: 0.5 });
    expect(firstFreeSlice(taken, 0.5)).toEqual({ start: 0.3, end: 0.5 });
    expect(firstFreeSlice([{ start: 0, end: 1 }], 0.1)).toBeNull();
    expect(firstFreeSlice([], 1)).toEqual({ start: 0, end: 1 });
  });

  it("treats touching slices as not overlapping", () => {
    expect(overlaps({ start: 0, end: 0.5 }, { start: 0.5, end: 1 })).toBe(false);
    expect(overlaps({ start: 0, end: 0.51 }, { start: 0.5, end: 1 })).toBe(true);
  });
});
