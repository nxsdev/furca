import type { Verdict } from "@furca/core/results/ExperimentResult";
import { barX, defineChart, dot, ruleX } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatCi, formatLift } from "~/components/results/format";

/** Interval paint: semantic color only for significant results; the point estimate always uses the full color */
const tone: Record<Verdict, { color: string; band: number }> = {
  winning: { color: "var(--success)", band: 0.25 },
  losing: { color: "var(--danger)", band: 0.25 },
  neutral: { color: "var(--muted)", band: 0.25 },
  inconclusive: { color: "var(--muted)", band: 0.15 },
};

/** Horizontal plot inset in px, so an estimate at the domain edge isn't cut. Axis headers inset by the same amount */
export const INTERVAL_INSET = 6;

/** One shared lift domain for a column of IntervalBars: covers zero and every interval, nice-rounded */
export function liftDomain(intervals: Iterable<readonly [number, number] | null>): readonly [number, number] {
  let lo = 0;
  let hi = 0;
  for (const ci of intervals) {
    if (ci === null) continue;
    lo = Math.min(lo, ci[0]);
    hi = Math.max(hi, ci[1]);
  }
  // ponytail: clamp to ±100% so one wild early interval doesn't flatten every other row; clipped bars run to the edge
  lo = Math.max(-1, lo);
  hi = Math.min(1, hi);
  if (hi - lo < 0.02) [lo, hi] = [lo - 0.01, hi + 0.01];
  const [min, max] = scaleLinear().domain([lo, hi]).nice(4).domain();
  return [min, max];
}

/** Tick values for a lift domain; the header axis and each bar's grid use the same ones */
export const liftTicks = (domain: readonly [number, number]): number[] => scaleLinear().domain(domain).ticks(4);

interface Interval {
  lift: number;
  low: number;
  high: number;
}

/**
 * Compact table-cell plot of a relative-lift interval on a shared `domain` (see `liftDomain`): zero rule,
 * interval colored by verdict, point estimate. `label` names the row for assistive tech; the exact values
 * become its description.
 */
export function IntervalBar({
  lift,
  ci,
  verdict,
  domain,
  label,
}: {
  lift: number | null;
  ci: readonly [number, number] | null;
  verdict: Verdict;
  domain: readonly [number, number];
  label: string;
}) {
  const { t } = useTranslation("charts");
  const [min, max] = domain;
  const low = ci?.[0];
  const high = ci?.[1];
  const definition = useMemo(() => {
    const { color, band } = tone[verdict];
    const rows: Array<Interval> = lift === null || low === undefined || high === undefined ? [] : [{ lift, low, high }];
    const lane = () => "ci";
    return defineChart({
      marks: [
        ruleX(liftTicks([min, max]), { strokeOpacity: 0.12 }),
        ruleX([0], { strokeOpacity: 0.5 }),
        barX(rows, { x1: "low", x2: "high", y: lane, fill: color, fillOpacity: band, maxThickness: 8, radius: 2 }),
        barX(rows, { x1: "low", x2: "high", y: lane, fill: color, fillOpacity: 0.55, maxThickness: 2 }),
        dot(rows, { x: "lift", y: lane, r: 4, fill: color, stroke: "var(--surface)", strokeWidth: 1.5 }),
      ],
      scales: {
        x: { scale: scaleLinear().domain([min, max]).clamp(true) },
        y: { scale: scaleBand<string>().domain(["ci"]) },
      },
      guides: false,
      margin: { top: 0, bottom: 0, left: INTERVAL_INSET, right: INTERVAL_INSET },
      pointer: false,
      keyboard: false,
    });
  }, [lift, low, high, verdict, min, max]);

  return (
    <Chart
      definition={definition}
      height={24}
      initialWidth={160}
      ariaLabel={label}
      ariaDescription={
        lift === null || ci === null ? t(($) => $.interval.empty) : t(($) => $.interval.description, { lift: formatLift(lift), ci: formatCi(ci) })
      }
      className="text-muted"
    />
  );
}
