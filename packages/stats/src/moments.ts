import type { MetricKind, Moments, VariationSummary } from "./types.ts";

/** Per-unit mean of one arm; ratio metrics use the ratio of sums (ΣM / ΣD) */
export function summarize(kind: MetricKind, m: Moments): VariationSummary {
  const denominator = kind === "ratio" ? (m.denominatorSum ?? 0) : m.n;
  return { n: m.n, total: m.sum, mean: denominator === 0 ? 0 : m.sum / denominator };
}

/**
 * Per-unit variance of one arm, as in gbstats `models/statistics.py`:
 * proportion p(1−p), mean (Σy² − (Σy)²/n)/(n−1), ratio via the delta method
 */
export function unitVariance(kind: MetricKind, m: Moments): number {
  if (kind !== "ratio") return baseVariance(kind, m.n, m.sum, m.sumSquares);
  const d = m.denominatorSum ?? 0;
  if (m.n <= 1 || d === 0) return 0;
  // ponytail: numerator and denominator are always treated as sample means; gbstats types each
  // by its own metric type, which only differs by n/(n−1) when a side is binomial
  return varianceOfRatios(
    m.sum / m.n,
    baseVariance("mean", m.n, m.sum, m.sumSquares),
    d / m.n,
    baseVariance("mean", m.n, d, m.denominatorSumSquares ?? 0),
    covariance("mean", m.n, m.sum, d, m.crossSum ?? 0),
  );
}

/** Unit variance of a proportion or sample-mean statistic */
export function baseVariance(kind: "proportion" | "mean", n: number, sum: number, sumSquares: number): number {
  if (kind === "proportion") {
    const p = n === 0 ? 0 : sum / n;
    return p * (1 - p);
  }
  return n <= 1 ? 0 : (sumSquares - (sum * sum) / n) / (n - 1);
}

/** Unit covariance from sums (gbstats `compute_covariance`) */
export function covariance(kind: "proportion" | "mean", n: number, sumA: number, sumB: number, sumProducts: number): number {
  if (n <= 1) return 0;
  return kind === "proportion" ? sumProducts / n - (sumA * sumB) / (n * n) : (sumProducts - (sumA * sumB) / n) / (n - 1);
}

/** Delta-method variance of M/D (gbstats `variance_of_ratios`) */
export function varianceOfRatios(meanM: number, varM: number, meanD: number, varD: number, cov: number): number {
  if (meanD === 0) return 0;
  return varM / meanD ** 2 + (varD * meanM ** 2) / meanD ** 4 - (2 * cov * meanM) / meanD ** 3;
}

function addMoments(a: Moments, b: Moments): Moments {
  const out: Record<string, number> = {};
  for (const [key, value] of [...Object.entries(a), ...Object.entries(b)]) out[key] = (out[key] ?? 0) + (value ?? 0);
  return out as unknown as Moments;
}

/**
 * Running sums of per-day moments, ordered by ISO date. `moments[i]` is variation i;
 * a variation missing on some day simply contributes nothing that day
 */
export function cumulative(
  daily: ReadonlyArray<{ readonly date: string; readonly moments: readonly Moments[] }>,
): Array<{ date: string; moments: Moments[] }> {
  let running: Moments[] = [];
  return [...daily]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, moments }) => {
      running = running.slice();
      moments.forEach((m, i) => {
        const prev = running[i];
        running[i] = prev ? addMoments(prev, m) : m;
      });
      return { date, moments: running };
    });
}
