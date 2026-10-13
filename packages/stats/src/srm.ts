import chisquareCdf from "@stdlib/stats-base-dists-chisquare-cdf";

/** p-value below which the traffic split is flagged as a sample ratio mismatch (GrowthBook default) */
export const SRM_THRESHOLD = 0.001;

/** GrowthBook waits for 8 units per variation before evaluating SRM */
const MIN_UNITS_PER_VARIATION = 8;

/**
 * Pearson χ² goodness-of-fit of observed units per variation against configured weights
 * (df = k − 1, gbstats `check_srm`). null when there is too little traffic to judge
 */
export function srmPValue(observed: readonly number[], weights: readonly number[]): number | null {
  const total = observed.reduce((a, b) => a + b, 0);
  if (observed.length < 2 || total < MIN_UNITS_PER_VARIATION * observed.length) return null;
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let x = 0;
  observed.forEach((o, i) => {
    const w = weights[i] ?? 0;
    if (w <= 0) return;
    const expected = (w / totalWeight) * total;
    x += (o - expected) ** 2 / expected;
  });
  return 1 - chisquareCdf(x, observed.length - 1);
}
