import { Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { areaY, defineChart, dot, lineY, whenFocused } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { chartHostClass } from "~/components/charts/theme";
import { hourlySeries } from "~/components/environments/Sparkline";
import { formatCount } from "~/components/results/format";
import { QueryError } from "~/components/ui/primitives";
import { intlLocale } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";

/** Identity colors validated for both themes (blue 255 / teal 190, CVD ΔE ≥ 15). Labels: `overview:traffic.series.<key>` */
const SERIES = [
  { key: "exposures", color: "var(--color-variation-1)" },
  { key: "events", color: "var(--color-variation-3)" },
] as const;

const hourLabel = (d: Date) => d.toLocaleTimeString(intlLocale(), { hour: "numeric" });
const compact = (v: number) => new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(v);

/** 0 / 1,000 / 2,000 …: about four whole-number steps of 1, 2, 2.5 or 5 × 10ⁿ covering `max` */
const niceTicks = (max: number) => {
  const raw = Math.max(max, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw);
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
};

/** Hourly exposures vs events for the last 24 hours of one environment */
export function TrafficChart({ environmentId, environmentName }: { environmentId: string; environmentName: string }) {
  const { t } = useTranslation("overview");
  const { t: tc } = useTranslation("charts");
  const volume = useQuery(orpc.events.volume.queryOptions({ input: { environmentId } }));
  const series = useMemo(() => (volume.data === undefined ? [] : hourlySeries(volume.data)), [volume.data]);
  const definition = useMemo(() => {
    const rows = series.flatMap((s) => SERIES.map(({ key }) => ({ id: `${key}:${s.hour.getTime()}`, hour: s.hour.getTime(), key, value: s[key] })));
    const ticks = niceTicks(Math.max(0, ...rows.map((r) => r.value)));
    return defineChart({
      marks: [
        decorative(areaY(rows, { x: "hour", y1: 0, y2: "value", color: "key", fillOpacity: 0.1 })),
        lineY(rows, { x: "hour", y: "value", color: "key", strokeWidth: 2 }),
        whenFocused(dot(rows, { x: "hour", y: "value", color: "key", r: 4, stroke: "var(--surface)", strokeWidth: 2 }), { match: "x" }),
        crosshair({ x: { strokeOpacity: 0.35 }, y: false }),
      ],
      scales: {
        x: {
          scale: scaleLinear,
          axis: {
            line: { strokeOpacity: 0.25 },
            // Every 6 hours on the local clock: 12 AM, 6 AM, 12 PM, 6 PM
            ticks: { values: series.filter((s) => s.hour.getHours() % 6 === 0).map((s) => s.hour.getTime()), size: 0, padding: 8, format: (ms) => hourLabel(new Date(ms)) },
          },
        },
        y: {
          scale: scaleLinear().domain([0, ticks.at(-1) ?? 1]),
          grid: { strokeOpacity: 0.1 },
          axis: { ticks: { values: ticks, size: 0, format: compact } },
        },
      },
      color: { domain: SERIES.map((s) => s.key), range: SERIES.map((s) => s.color) },
      focus: "group-x",
      focusRing: false,
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        anchor: "group-center",
        sort: "color-domain",
        placement: ["right", "left", "top", "bottom"],
        content: (points) => {
          const hour = points[0]?.datum.hour;
          return {
            title: hour === undefined ? "" : new Date(hour).toLocaleString(intlLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" }),
            rows: points.map((p) => ({ label: t(($) => $.traffic.series[p.datum.key]), value: formatCount(p.datum.value), color: p.color })),
          };
        },
      },
    });
  }, [series, t]);
  if (volume.isPending)
    return (
      <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label={t(($) => $.traffic.loading)}>
        <Skeleton className="h-4 w-48 rounded-md" />
        <Skeleton className="h-[160px] rounded-md" />
      </div>
    );
  if (volume.isError)
    return (
      <div className="p-4">
        <QueryError message={t(($) => $.traffic.loadFailed, { message: errorMessage(volume.error) })} onRetry={() => volume.refetch()} />
      </div>
    );

  const totals = {
    exposures: series.reduce((a, s) => a + s.exposures, 0),
    events: series.reduce((a, s) => a + s.events, 0),
  };
  if (totals.exposures + totals.events === 0)
    return (
      <div className="flex flex-col gap-1 px-5 py-8">
        <p className="text-body font-medium">{t(($) => $.traffic.emptyTitle, { name: environmentName })}</p>
        <p className="text-label text-muted">
          <Trans t={t} i18nKey={($) => $.traffic.emptyDescription} components={{ code: <code className="font-mono text-foreground" /> }} />
        </p>
      </div>
    );

  return (
    <div className="flex flex-col gap-3 px-5 pt-4 pb-3">
      <ul className="flex flex-wrap gap-x-6 gap-y-1" aria-label={t(($) => $.traffic.totals)}>
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-label">
            <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
            <span className="text-muted">{t(($) => $.traffic.series[s.key])}</span>
            <span className="font-mono font-medium tabular">{formatCount(totals[s.key])}</span>
          </li>
        ))}
      </ul>
      <Chart
        definition={definition}
        height={160}
        initialWidth={640}
        ariaLabel={tc(($) => $.traffic.label, { name: environmentName })}
        ariaDescription={`${tc(($) => $.traffic.description)} ${tc(($) => $.keyboardHint)}`}
        className={chartHostClass}
      />
      {/* sr-only on the table itself doesn't shrink it (tables size to content) and widens the page on phones */}
      <div className="sr-only">
        <table>
          <caption>{t(($) => $.traffic.tableCaption, { name: environmentName })}</caption>
          <thead>
            <tr>
              <th>{t(($) => $.traffic.hour)}</th>
              <th>{t(($) => $.traffic.series.exposures)}</th>
              <th>{t(($) => $.traffic.series.events)}</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.hour.getTime()}>
                <td>{hourLabel(s.hour)}</td>
                <td>{s.exposures}</td>
                <td>{s.events}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
