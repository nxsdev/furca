import normalQuantile from "@stdlib/stats-base-dists-normal-quantile";

/**
 * Fixed-horizon, two-sided power inputs: relative effects,
 * equal variance in both arms, per pairwise comparison without multiple-testing correction
 */
export interface PowerInput {
  readonly kind: "proportion" | "mean";
  /** Baseline conversion rate (proportion) or per-user mean; must be > 0 */
  readonly baselineMean: number;
  /** Per-user standard deviation; required for mean metrics */
  readonly baselineStdDev?: number;
  readonly alpha: number;
  /** Default 0.8 */
  readonly power?: number;
  /** Accepted for planner convenience; the size is per variation for each pairwise comparison */
  readonly variations?: number;
}

/** k²σ²/μ² with k = z(1−α/2) − z(1−π); null for unusable inputs */
function scaledVariance({ kind, baselineMean: mu, baselineStdDev, alpha, power = 0.8 }: PowerInput): number | null {
  const variance = kind === "proportion" ? mu * (1 - mu) : (baselineStdDev ?? Number.NaN) ** 2;
  if (!(mu > 0 && variance > 0 && alpha > 0 && alpha < 1 && power > 0 && power < 1)) return null;
  const k = normalQuantile(1 - alpha / 2, 0, 1) - normalQuantile(1 - power, 0, 1);
  return (k * k * variance) / (mu * mu);
}

/**
 * Users per variation to detect a relative lift `mde` (> 0). Solves
 * mde / σ_Δ = k with σ²_Δ = σ²/N · (1 + (1 + mde)²) / μ²
 */
export function sampleSizePerVariation(input: PowerInput & { readonly mde: number }): number | null {
  const q = scaledVariance(input);
  const d = input.mde;
  if (q === null || !(d > 0)) return null;
  return Math.ceil((q * (1 + (1 + d) ** 2)) / (d * d));
}

/**
 * Smallest detectable relative lift at `usersPerVariation` (positive root of the power equation as a quadratic in the lift);
 * null when no MDE exists, i.e. N ≤ k²σ²/μ²
 */
export function mdeForSampleSize(input: PowerInput & { readonly usersPerVariation: number }): number | null {
  const q = scaledVariance(input);
  if (q === null || !(input.usersPerVariation > 0)) return null;
  const c = q / input.usersPerVariation;
  if (c >= 1) return null;
  return (c + Math.sqrt(c * (2 - c))) / (1 - c);
}

/** Days until every variation has `usersPerVariation`, assuming an equal split of covered traffic */
export function daysToReach({
  usersPerVariation,
  variations,
  dailyTraffic,
  coverage,
}: {
  readonly usersPerVariation: number;
  readonly variations: number;
  /** Eligible users per day */
  readonly dailyTraffic: number;
  /** Share of eligible traffic in the experiment, 0–1 */
  readonly coverage: number;
}): number | null {
  const perDay = dailyTraffic * coverage;
  if (!(perDay > 0)) return null;
  return Math.ceil((usersPerVariation * variations) / perDay);
}
