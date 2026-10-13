import type { MetricType } from "@furca/core/metrics/Metric";

const MINUS = "−";
const countFormat = new Intl.NumberFormat("en-US");

/** 12,345 */
export const formatCount = (n: number): string => countFormat.format(Math.round(n));

/** Relative change as a signed percentage: +4.2%, −0.35% (two decimals below 1%) */
export const formatLift = (x: number): string => {
  const pct = x * 100;
  const digits = Math.abs(pct) < 1 && pct !== 0 ? 2 : 1;
  const text = Math.abs(pct).toFixed(digits);
  if (Number(text) === 0) return "0.0%";
  return `${pct < 0 ? MINUS : "+"}${text}%`;
};

/** [+1.1%, +7.3%] */
export const formatCi = (ci: readonly [number, number]): string => `[${formatLift(ci[0])}, ${formatLift(ci[1])}]`;

/** 0.012, <0.001 */
export const formatPValue = (p: number): string => (p < 0.001 ? "<0.001" : p.toFixed(3));

/** "p = 0.012" / "p < 0.001" for prose */
export const pText = (p: number): string => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

/** 97.3% */
export const formatPercent = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;

/** Metric value per variation: rate as %, mean / ratio with up to 3 significant decimals */
export const formatMetricValue = (type: MetricType, mean: number): string => {
  if (type === "proportion") return formatPercent(mean, mean < 0.1 ? 2 : 1);
  const abs = Math.abs(mean);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(mean);
};

/** "3 days", "1 day", "<1 day" between two dates */
export const formatDuration = (from: Date, to: Date): string => {
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000);
  if (days < 1) return "<1 day";
  return days === 1 ? "1 day" : `${formatCount(days)} days`;
};

/** Oct 13, 2026, 2:14 AM */
export const formatDateTime = (d: Date): string =>
  d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
