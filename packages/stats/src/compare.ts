import normalCdf from "@stdlib/stats-base-dists-normal-cdf";
import normalQuantile from "@stdlib/stats-base-dists-normal-quantile";
import tCdf from "@stdlib/stats-base-dists-t-cdf";
import tQuantile from "@stdlib/stats-base-dists-t-quantile";
import { baseVariance, covariance, summarize, unitVariance } from "./moments.ts";
import type { AnalysisSettings, ComparisonOutcome, MetricKind, Moments } from "./types.ts";

export interface CompareInput {
  readonly kind: MetricKind;
  /** Lower is better */
  readonly inverse: boolean;
  readonly control: Moments;
  readonly treatment: Moments;
  readonly settings: AnalysisSettings;
}

export type Verdict = "winning" | "losing" | "neutral" | "inconclusive";

interface Pre {
  readonly sum: number;
  readonly sumSquares: number;
  readonly products: number;
}

const preOf = (m: Moments): Pre | null =>
  m.preSum === undefined || m.preSumSquares === undefined || m.prePostSum === undefined
    ? null
    : { sum: m.preSum, sumSquares: m.preSumSquares, products: m.prePostSum };

const fail = (reason: string): ComparisonOutcome => ({ ok: false, reason });

/** θ = Cov(Y, X) / Var(X) pooled over both arms (gbstats `compute_theta`); 0 disables CUPED */
function cupedTheta(kind: "proportion" | "mean", a: Moments, preA: Pre, b: Moments, preB: Pre): number {
  const n = a.n + b.n;
  const postVariance = baseVariance(kind, n, a.sum + b.sum, a.sumSquares + b.sumSquares);
  const preVariance = baseVariance(kind, n, preA.sum + preB.sum, preA.sumSquares + preB.sumSquares);
  if (postVariance === 0 || preVariance === 0) return 0;
  return covariance(kind, n, a.sum + b.sum, preA.sum + preB.sum, preA.products + preB.products) / preVariance;
}

/** ρ of the asymptotic confidence sequence (Waudby-Smith et al. 2023 eq. 161, two-sided) */
function sequentialRho(alpha: number, tuning: number): number {
  return Math.sqrt((-2 * Math.log(alpha) + Math.log(-2 * Math.log(alpha) + 1)) / tuning);
}

/**
 * Relative lift of treatment over control with GrowthBook's (gbstats) math:
 * delta-method variance, optional CUPED, Welch t / sequential / Gaussian-prior Bayesian
 */
export function compareVariations({ kind, inverse, control: c, treatment: t, settings }: CompareInput): ComparisonOutcome {
  if (c.n < 2 || t.n < 2) return fail("Not enough data yet");
  if (kind === "ratio" && (c.denominatorSum === undefined || t.denominatorSum === undefined)) {
    return fail("Ratio metric is missing denominator data");
  }

  const preC = preOf(c);
  const preT = preOf(t);
  const theta = settings.cuped && kind !== "ratio" && preC && preT ? cupedTheta(kind, c, preC, t, preT) : 0;

  const arm = (m: Moments, pre: Pre | null) => {
    const mean = summarize(kind, m).mean;
    const variance = unitVariance(kind, m);
    if (theta === 0 || !pre || kind === "ratio") {
      return { mean, adjMean: mean, variance, adjVariance: variance, preVariance: 0, cov: 0 };
    }
    const preVariance = baseVariance(kind, m.n, pre.sum, pre.sumSquares);
    const cov = covariance(kind, m.n, m.sum, pre.sum, pre.products);
    return {
      mean,
      adjMean: mean - (theta * pre.sum) / m.n,
      variance,
      adjVariance: variance + theta ** 2 * preVariance - 2 * theta * cov,
      preVariance,
      cov,
    };
  };
  const C = arm(c, preC);
  const T = arm(t, preT);

  if (C.mean === 0 || C.adjMean === 0) return fail("Control mean is zero");
  if (C.adjVariance <= 0 || T.adjVariance <= 0) return fail("Metric has no variance yet");

  // frequentist_variance_relative_cuped; with θ = 0 it reduces to the plain delta method
  const r = T.mean / C.mean;
  const variance =
    T.adjVariance / (t.n * C.mean ** 2) +
    (C.variance * r ** 2 - 2 * theta * C.cov * r + theta ** 2 * C.preVariance) / (c.n * C.mean ** 2);
  if (!(variance > 0)) return fail("Metric has no variance yet");

  const lift = (T.adjMean - C.adjMean) / Math.abs(C.mean);
  const se = Math.sqrt(variance);
  const base = { absoluteDiff: T.adjMean - C.adjMean, cupedApplied: theta !== 0 };
  const { alpha } = settings;

  if (settings.engine === "bayesian") {
    const prior = settings.priorStdDev;
    const precision = 1 / variance + (prior ? 1 / prior ** 2 : 0);
    const mean = prior ? lift / variance / precision : lift;
    const sd = Math.sqrt(1 / precision);
    return {
      ok: true,
      result: {
        ...base,
        lift: mean,
        ci: [normalQuantile(alpha / 2, mean, sd), normalQuantile(1 - alpha / 2, mean, sd)],
        pValue: null,
        chanceToWin: normalCdf((inverse ? -mean : mean) / sd, 0, 1),
        standardError: sd,
      },
    };
  }

  if (settings.sequential) {
    const n = c.n + t.n;
    const rho = sequentialRho(alpha, settings.sequentialTuning);
    const nr2p1 = n * rho ** 2 + 1;
    const halfwidth = se * Math.sqrt(n) * Math.sqrt((2 * nr2p1 * Math.log(Math.sqrt(nr2p1) / alpha)) / (n * rho) ** 2);
    // p = min(1, 1/e-value), eq. 155, written as a product to avoid exp overflow
    const pValue = Math.min(1, Math.sqrt(nr2p1) * Math.exp(-(rho ** 2 * ((lift ** 2 * n) / variance)) / (2 * nr2p1)));
    return { ok: true, result: { ...base, lift, ci: [lift - halfwidth, lift + halfwidth], pValue, chanceToWin: null, standardError: se } };
  }

  // Welch–Satterthwaite on per-unit variances, as gbstats does even for relative effects
  const vC = C.adjVariance / c.n;
  const vT = T.adjVariance / t.n;
  const dof = (vT + vC) ** 2 / (vT ** 2 / (t.n - 1) + vC ** 2 / (c.n - 1));
  const halfwidth = tQuantile(1 - alpha / 2, dof) * se;
  return {
    ok: true,
    result: {
      ...base,
      lift,
      ci: [lift - halfwidth, lift + halfwidth],
      pValue: 2 * tCdf(-Math.abs(lift / se), dof),
      chanceToWin: null,
      standardError: se,
    },
  };
}

/**
 * Frequentist: significant when p < alpha, direction by lift sign (flipped for inverse).
 * Bayesian: chanceToWin ≥ 1 − alpha/2 wins, ≤ alpha/2 loses
 */
export function verdict(
  outcome: ComparisonOutcome,
  { engine, alpha, inverse }: { readonly engine: AnalysisSettings["engine"]; readonly alpha: number; readonly inverse: boolean },
): Verdict {
  if (!outcome.ok) return "inconclusive";
  const { pValue, chanceToWin, lift } = outcome.result;
  if (engine === "bayesian") {
    if (chanceToWin === null) return "inconclusive";
    return chanceToWin >= 1 - alpha / 2 ? "winning" : chanceToWin <= alpha / 2 ? "losing" : "neutral";
  }
  if (pValue === null) return "inconclusive";
  if (pValue >= alpha) return "neutral";
  return lift > 0 !== inverse ? "winning" : "losing";
}

/** Holm–Bonferroni adjusted p-values, returned in input order (monotone in rank) */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const out = new Array<number>(m);
  let running = 0;
  pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p)
    .forEach(({ p, i }, rank) => {
      running = Math.max(running, Math.min(1, p * (m - rank)));
      out[i] = running;
    });
  return out;
}

/** Interval on lift implied by a corrected p-value (GrowthBook `adjustedCI` / `getAdjustedCI`) */
export function adjustedInterval(adjustedP: number, lift: number, alpha: number): [number, number] {
  if (adjustedP > 0.999999) return [-Infinity, Infinity];
  const width = normalQuantile(1 - alpha / 2, 0, 1) * Math.abs(lift / normalQuantile(1 - adjustedP / 2, 0, 1));
  return [lift - width, lift + width];
}
