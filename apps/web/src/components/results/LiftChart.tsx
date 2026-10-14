import type { Experiment } from "@furca/core/experiments/Experiment";
import type { MetricResult } from "@furca/core/results/ExperimentResult";
import { areaY, defineChart, dot, lineY, ruleY, whenFocused } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { chartHostClass } from "~/components/charts/theme";
import { VariationSwatch, variationColor } from "~/components/experiments/parts";
import { intlLocale } from "~/i18n";
import { formatCi, formatCount, formatLift } from "./format";

const DAY = (date: string) => Date.parse(`${date}T00:00:00Z`);
const shortDate = (ms: number) => new Date(ms).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
/** Axis ticks: +5%, −10%, 0% */
const tickPercent = (v: number) => (Math.abs(v) < 1e-9 ? "0%" : `${v > 0 ? "+" : "\u2212"}${Number(Math.abs(v * 100).toPrecision(2))}%`);

/** Cumulative relative lift by first-exposure date, one line + interval band per treatment */
export function LiftChart({ experiment, result }: { experiment: Experiment; result: MetricResult }) {
  const { t } = useTranslation("results");
  const { t: tc } = useTranslation("charts");
  const treatments = experiment.variations.map((v, index) => ({ ...v, index })).slice(1);
  const control = experiment.variations[0]?.name ?? t("table.controlFallback");

  const definition = useMemo(() => {
    const rows = result.timeseries.flatMap((p) =>
      treatments.map((v) => {
        const c = p.comparisons.find((x) => x.variationKey === v.key);
        return {
          id: `${v.key}:${p.date}`,
          day: DAY(p.date),
          users: p.users,
          key: v.key,
          name: v.name,
          lift: c?.lift ?? null,
          low: c?.ci?.[0] ?? null,
          high: c?.ci?.[1] ?? null,
        };
      }),
    );
    // Early days have huge intervals and wild lifts; scale to the latest interval so the current estimate stays
    // readable. Earlier values outside it are clipped at the plot edge (exact values are in the table)
    const last = result.timeseries.at(-1)?.comparisons ?? [];
    const reach = Math.max(0.05, ...last.flatMap((c) => [Math.abs(c.lift ?? 0), ...(c.ci === null ? [] : c.ci.map(Math.abs))]));
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2].find((x) => (reach * 1.3) / x <= 3) ?? 5;
    const cap = Math.ceil((reach * 1.3) / step) * step;
    const ticks = Array.from({ length: Math.round((2 * cap) / step) + 1 }, (_, i) => Number((-cap + i * step).toFixed(4)));

    return defineChart({
      marks: [
        ruleY([0], { strokeDasharray: "3 3", strokeOpacity: 0.8 }),
        decorative(areaY(rows, { x: "day", y1: "low", y2: "high", color: "key", fillOpacity: 0.14 })),
        lineY(rows, { x: "day", y: "lift", color: "key", strokeWidth: 2 }),
        whenFocused(dot(rows, { x: "day", y: "lift", color: "key", r: 4, stroke: "var(--surface)", strokeWidth: 2 }), { match: "x" }),
        crosshair({ x: { strokeOpacity: 0.35 }, y: false }),
      ],
      scales: {
        x: {
          scale: scaleLinear,
          axis: { line: { strokeOpacity: 0.25 }, ticks: { values: result.timeseries.map((p) => DAY(p.date)), size: 0, padding: 8, format: shortDate }, tickLabels: { thin: { minGap: 12 } } },
        },
        y: {
          scale: scaleLinear().domain([-cap, cap]),
          grid: { strokeOpacity: 0.1 },
          axis: { ticks: { values: ticks, size: 0, format: tickPercent } },
        },
      },
      color: { domain: treatments.map((v) => v.key), range: treatments.map((v) => variationColor(v.index)) },
      clip: true,
      focus: "group-x",
      focusRing: false,
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        anchor: "group-center",
        sort: "color-domain",
        placement: ["right", "left", "top", "bottom"],
        content: (points) => {
          const first = points[0]?.datum;
          return {
            title:
              first === undefined
                ? ""
                : tc("lift.tooltipTitle", { count: first.users, date: shortDate(first.day), users: formatCount(first.users) }),
            rows: points.map((p) => ({
              label: p.datum.name,
              value: `${p.datum.lift === null ? "–" : formatLift(p.datum.lift)}  ${p.datum.low === null || p.datum.high === null ? "" : formatCi([p.datum.low, p.datum.high])}`,
              color: p.color,
            })),
          };
        },
      },
    });
  }, [experiment, result, tc]);

  if (result.timeseries.length < 2) {
    return (
      <p className="px-5 py-10 text-center text-body text-muted">
        {t("chart.tooFewDays")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-2 pt-4 pb-2 sm:px-4">
      {treatments.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 text-meta text-muted" aria-label={t("chart.legend")}>
          {treatments.map((t) => (
            <li key={t.key} className="inline-flex items-center gap-1.5">
              <VariationSwatch index={t.index} />
              {t.name}
            </li>
          ))}
        </ul>
      )}
      <Chart
        definition={definition}
        height={256}
        initialWidth={720}
        ariaLabel={tc("lift.label")}
        ariaDescription={`${tc("lift.description", { control })} ${tc("keyboardHint")}`}
        className={chartHostClass}
      />
      <details className="group px-3 pb-2 text-meta">
        <summary className="cursor-pointer select-none text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
          {t("chart.showTable")}
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full font-mono tabular">
            <thead className="text-muted">
              <tr className="[&>th]:py-1 [&>th]:pr-4 [&>th]:text-left [&>th]:font-normal">
                <th scope="col" className="font-sans">{t("chart.firstExposure")}</th>
                <th scope="col" className="font-sans">{t("chart.users")}</th>
                {treatments.map((t) => (
                  <th key={t.key} scope="col" className="font-sans">
                    {t.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.timeseries.map((p) => (
                <tr key={p.date} className="border-t border-border [&>td]:py-1 [&>td]:pr-4">
                  <td>{p.date}</td>
                  <td>{formatCount(p.users)}</td>
                  {treatments.map((t) => {
                    const c = p.comparisons.find((x) => x.variationKey === t.key);
                    return (
                      <td key={t.key}>
                        {c?.lift == null ? "–" : formatLift(c.lift)} {c?.ci == null ? "" : formatCi(c.ci)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
