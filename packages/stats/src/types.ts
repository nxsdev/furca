/**
 * Summable sufficient statistics for one variation of one metric.
 * Every field is a plain sum over analysis units (users), so per-day partial aggregates
 * from D1 or BigQuery can be added together to get cumulative results
 */
export interface Moments {
  /** Number of units */
  readonly n: number;
  /** Σy: per-unit metric value (numerator for ratio metrics) */
  readonly sum: number;
  /** Σy² */
  readonly sumSquares: number;
  /** Ratio metrics: Σd (denominator), Σd², Σyd */
  readonly denominatorSum?: number;
  readonly denominatorSumSquares?: number;
  readonly crossSum?: number;
  /** CUPED: Σx (same metric, pre-exposure lookback), Σx², Σxy */
  readonly preSum?: number;
  readonly preSumSquares?: number;
  readonly prePostSum?: number;
}

export type MetricKind = "proportion" | "mean" | "ratio";

export interface AnalysisSettings {
  readonly engine: "frequentist" | "bayesian";
  /** Frequentist only: always-valid confidence sequence (Waudby-Smith et al.) */
  readonly sequential: boolean;
  /** N*: total sample (both arms) where the sequence is tightest */
  readonly sequentialTuning: number;
  /** e.g. 0.05 */
  readonly alpha: number;
  /** Use pre-exposure moments when present (not for ratio metrics) */
  readonly cuped: boolean;
  /** Bayesian prior on relative lift; null = flat (improper) prior */
  readonly priorStdDev?: number | null;
}

export interface ComparisonResult {
  /** (μT − μC) / |μC| with CUPED-adjusted numerator when applied; Bayesian: posterior mean */
  readonly lift: number;
  /** Interval on relative lift (confidence, sequential confidence, or credible) */
  readonly ci: readonly [number, number];
  readonly absoluteDiff: number;
  /** Frequentist p-value (sequential if enabled), before multiple-comparison correction */
  readonly pValue: number | null;
  /** Bayesian P(treatment better), already flipped for inverse metrics */
  readonly chanceToWin: number | null;
  /** Standard error of the relative lift; Bayesian: posterior standard deviation */
  readonly standardError: number;
  readonly cupedApplied: boolean;
}

export type ComparisonOutcome =
  | { readonly ok: true; readonly result: ComparisonResult }
  | { readonly ok: false; readonly reason: string };

export interface VariationSummary {
  readonly n: number;
  readonly total: number;
  readonly mean: number;
}
