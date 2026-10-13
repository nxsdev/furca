import { describe, expect, it } from "bun:test";
import { compareVariations, verdict, type AnalysisSettings, type ComparisonOutcome, type Moments } from "../src/index.ts";

const frequentist: AnalysisSettings = { engine: "frequentist", sequential: false, sequentialTuning: 5000, alpha: 0.05, cuped: false };
const proportion = (n: number, conversions: number): Moments => ({ n, sum: conversions, sumSquares: conversions });
const control = proportion(10_000, 1_000);
const treatment = proportion(10_000, 1_100);

const resultOf = (outcome: ComparisonOutcome) => {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.result;
};
const compare = (settings: Partial<AnalysisSettings>, inverse = false) =>
  compareVariations({ kind: "proportion", inverse, control, treatment, settings: { ...frequentist, ...settings } });

/** Moments from (pre x, post y) rows for a mean metric */
const withPre = (rows: ReadonlyArray<readonly [number, number]>): Moments => ({
  n: rows.length,
  sum: rows.reduce((s, [, y]) => s + y, 0),
  sumSquares: rows.reduce((s, [, y]) => s + y * y, 0),
  preSum: rows.reduce((s, [x]) => s + x, 0),
  preSumSquares: rows.reduce((s, [x]) => s + x * x, 0),
  prePostSum: rows.reduce((s, [x, y]) => s + x * y, 0),
});

describe("compareVariations golden vectors (10% vs 11%, 10k users each)", () => {
  it("fixed-horizon Welch t matches the normal-approx vector to 4 decimals", () => {
    const r = resultOf(compare({}));
    expect(r.lift).toBeCloseTo(0.1, 10);
    expect(r.standardError).toBeCloseTo(0.045475, 6);
    expect(r.pValue).toBeCloseTo(0.027878, 4);
    expect(r.ci[0]).toBeCloseTo(0.01087, 4);
    expect(r.ci[1]).toBeCloseTo(0.18913, 4);
    expect(r.absoluteDiff).toBeCloseTo(0.01, 12);
    expect(r.chanceToWin).toBeNull();
    expect(r.cupedApplied).toBe(false);
  });

  it("sequential with N*=5000 widens the interval and uses the e-value p-value", () => {
    const r = resultOf(compare({ sequential: true }));
    expect(r.ci[1] - r.lift).toBeCloseTo(0.142206, 6);
    expect(r.pValue).toBeCloseTo(0.549038, 6);
  });

  it("bayesian flat prior gives chanceToWin 0.986061 and no p-value", () => {
    const r = resultOf(compare({ engine: "bayesian" }));
    expect(r.chanceToWin).toBeCloseTo(0.986061, 6);
    expect(r.pValue).toBeNull();
    expect(r.ci[0]).toBeCloseTo(0.01087, 5);
  });

  it("bayesian N(0, 0.3²) prior shrinks the lift", () => {
    const r = resultOf(compare({ engine: "bayesian", priorStdDev: 0.3 }));
    expect(r.lift).toBeCloseTo(0.097754, 6);
    expect(r.standardError).toBeCloseTo(0.044962, 6);
    expect(r.chanceToWin).toBeCloseTo(0.985153, 6);
  });

  it("inverse metric flips chanceToWin", () => {
    expect(resultOf(compare({ engine: "bayesian" }, true)).chanceToWin).toBeCloseTo(1 - 0.986061, 6);
  });
});

describe("compareVariations CUPED", () => {
  const ctrl = withPre([[4, 5], [6, 6], [8, 9], [10, 10], [3, 4], [7, 7], [5, 5], [9, 11]]);
  const trt = withPre([[5, 7], [7, 8], [9, 10], [4, 6], [6, 8], [8, 9], [10, 12], [3, 5]]);
  const run = (cuped: boolean, c = ctrl, t = trt) =>
    resultOf(compareVariations({ kind: "mean", inverse: false, control: c, treatment: t, settings: { ...frequentist, cuped } }));

  it("strongly correlated pre-period shrinks the standard error (row-level vector)", () => {
    const adjusted = run(true);
    const plain = run(false);
    expect(adjusted.cupedApplied).toBe(true);
    expect(adjusted.lift).toBeCloseTo(0.14035087719298245, 12);
    expect(adjusted.absoluteDiff).toBeCloseTo(1, 12);
    expect(adjusted.standardError).toBeCloseTo(0.05396487285508543, 12);
    expect(plain.standardError).toBeCloseTo(0.18360085842105128, 12);
  });

  it("falls back silently when θ = 0 (no pre-period variance)", () => {
    const noPre = (m: Moments): Moments => ({ ...m, preSum: 0, preSumSquares: 0, prePostSum: 0 });
    const r = run(true, noPre(ctrl), noPre(trt));
    expect(r.cupedApplied).toBe(false);
    expect(r).toEqual(run(false));
  });

  it("is skipped when pre-period moments are missing on an arm", () => {
    expect(run(true, ctrl, { n: trt.n, sum: trt.sum, sumSquares: trt.sumSquares }).cupedApplied).toBe(false);
  });
});

describe("compareVariations ratio metric", () => {
  const ratio = (rows: ReadonlyArray<readonly [number, number]>): Moments => ({
    n: rows.length,
    sum: rows.reduce((s, [m]) => s + m, 0),
    sumSquares: rows.reduce((s, [m]) => s + m * m, 0),
    denominatorSum: rows.reduce((s, [, d]) => s + d, 0),
    denominatorSumSquares: rows.reduce((s, [, d]) => s + d * d, 0),
    crossSum: rows.reduce((s, [m, d]) => s + m * d, 0),
  });

  it("uses ratio of sums and delta-method variance (row-level vector)", () => {
    const r = resultOf(
      compareVariations({
        kind: "ratio",
        inverse: false,
        control: ratio([[3, 2], [0, 1], [5, 4], [2, 2], [4, 3], [1, 1]]),
        treatment: ratio([[4, 2], [2, 1], [6, 4], [3, 2], [5, 3], [2, 2]]),
        settings: { ...frequentist, cuped: true },
      }),
    );
    expect(r.lift).toBeCloseTo(0.361904761904762, 12);
    expect(r.standardError).toBeCloseTo(0.18570872052329537, 12);
    expect(r.cupedApplied).toBe(false);
  });
});

describe("compareVariations guards", () => {
  const reason = (c: Moments, t: Moments, kind: "proportion" | "mean" = "proportion") => {
    const outcome = compareVariations({ kind, inverse: false, control: c, treatment: t, settings: frequentist });
    return outcome.ok ? null : outcome.reason;
  };

  it("needs at least 2 units per arm", () => expect(reason(proportion(1, 1), treatment)).toBe("Not enough data yet"));
  it("rejects a zero control mean", () => expect(reason(proportion(100, 0), treatment)).toBe("Control mean is zero"));
  it("rejects zero variance", () =>
    expect(reason({ n: 3, sum: 6, sumSquares: 12 }, { n: 3, sum: 9, sumSquares: 29 }, "mean")).toBe("Metric has no variance yet"));
});

describe("verdict", () => {
  const opts = { engine: "frequentist", alpha: 0.05, inverse: false } as const;

  it("significant positive lift wins, and loses for inverse metrics", () => {
    expect(verdict(compare({}), opts)).toBe("winning");
    expect(verdict(compare({}, true), { ...opts, inverse: true })).toBe("losing");
  });
  it("non-significant sequential result is neutral", () => expect(verdict(compare({ sequential: true }), opts)).toBe("neutral"));
  it("bayesian chanceToWin ≥ 1 − alpha/2 wins", () =>
    expect(verdict(compare({ engine: "bayesian" }), { ...opts, engine: "bayesian" })).toBe("winning"));
  it("failed comparison is inconclusive", () => expect(verdict({ ok: false, reason: "x" }, opts)).toBe("inconclusive"));
});
