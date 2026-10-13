import { describe, expect, it } from "bun:test";
import { formatCi, formatLift, formatMetricValue, formatPValue, pText } from "./format";
import { headlineComparison } from "./verdict";

describe("result formatting", () => {
  it("signs lifts and uses two decimals below 1%", () => {
    expect(formatLift(0.042)).toBe("+4.2%");
    expect(formatLift(-0.031)).toBe("−3.1%");
    expect(formatLift(0.0035)).toBe("+0.35%");
    expect(formatLift(0.00001)).toBe("0.0%");
  });

  it("formats intervals, p-values and metric values", () => {
    expect(formatCi([0.011, 0.073])).toBe("[+1.1%, +7.3%]");
    expect(formatPValue(0.0123)).toBe("0.012");
    expect(formatPValue(0.0002)).toBe("<0.001");
    expect(pText(0.0002)).toBe("p < 0.001");
    expect(formatMetricValue("proportion", 0.0937)).toBe("9.37%");
    expect(formatMetricValue("mean", 1234.5)).toBe("1,235");
  });
});

describe("headlineComparison", () => {
  const c = (variationKey: string, verdict: "winning" | "losing" | "neutral", lift: number) =>
    ({ variationKey, verdict, lift, ci: null, absoluteDiff: null, pValue: null, chanceToWin: null, message: null }) as const;

  it("leads with the strongest winner, then the worst loser", () => {
    const metric = { comparisons: [c("a", "neutral", 0.01), c("b", "winning", 0.03), c("d", "winning", 0.05), c("e", "losing", -0.2)] };
    expect(headlineComparison(metric as never)?.variationKey).toBe("d");
    expect(headlineComparison({ comparisons: [c("a", "neutral", 0.01), c("e", "losing", -0.2)] } as never)?.variationKey).toBe("e");
  });
});
