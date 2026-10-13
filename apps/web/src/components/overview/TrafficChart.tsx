import { Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: { hour: Date; exposures: number; events: number } }>;
}) {
  const { t } = useTranslation("overview");
  const row = payload?.[0]?.payload;
  if (active !== true || row === undefined) return null;
  return (
    <div className="min-w-36 rounded-md border border-border bg-overlay px-3 py-2 text-label shadow-overlay">
      <p className="mb-1 text-meta text-muted">
        {row.hour.toLocaleString(intlLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" })}
      </p>
      {SERIES.map((s) => (
        <p key={s.key} className="flex items-center gap-2">
          <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
          <span className="font-mono font-medium tabular">{formatCount(row[s.key])}</span>
          <span className="text-muted">{t(`traffic.series.${s.key}`).toLowerCase()}</span>
        </p>
      ))}
    </div>
  );
}

/** Hourly exposures vs events for the last 24 hours of one environment */
export function TrafficChart({ environmentId, environmentName }: { environmentId: string; environmentName: string }) {
  const { t } = useTranslation("overview");
  const volume = useQuery(orpc.events.volume.queryOptions({ input: { environmentId } }));
  if (volume.isPending)
    return (
      <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label={t("traffic.loading")}>
        <Skeleton className="h-4 w-48 rounded-md" />
        <Skeleton className="h-[160px] rounded-md" />
      </div>
    );
  if (volume.isError)
    return (
      <div className="p-4">
        <QueryError message={t("traffic.loadFailed", { message: errorMessage(volume.error) })} onRetry={() => volume.refetch()} />
      </div>
    );

  const series = hourlySeries(volume.data);
  const totals = {
    exposures: series.reduce((a, s) => a + s.exposures, 0),
    events: series.reduce((a, s) => a + s.events, 0),
  };
  if (totals.exposures + totals.events === 0)
    return (
      <div className="flex flex-col gap-1 px-5 py-8">
        <p className="text-body font-medium">{t("traffic.emptyTitle", { name: environmentName })}</p>
        <p className="text-label text-muted">
          <Trans t={t} i18nKey="traffic.emptyDescription" components={{ code: <code className="font-mono text-foreground" /> }} />
        </p>
      </div>
    );

  const ticks = niceTicks(Math.max(...series.map((s) => Math.max(s.exposures, s.events))));
  return (
    <div className="flex flex-col gap-3 px-5 pt-4 pb-3">
      <ul className="flex flex-wrap gap-x-6 gap-y-1" aria-label={t("traffic.totals")}>
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-label">
            <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
            <span className="text-muted">{t(`traffic.series.${s.key}`)}</span>
            <span className="font-mono font-medium tabular">{formatCount(totals[s.key])}</span>
          </li>
        ))}
      </ul>
      <div className="h-[160px]" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--separator)" />
            <XAxis
              dataKey="hour"
              tickFormatter={(d: Date) => hourLabel(d)}
              interval={5}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickMargin={6}
            />
            <YAxis
              ticks={ticks}
              domain={[0, ticks.at(-1) ?? 1]}
              interval={0}
              tickFormatter={compact}
              width={36}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--muted)", strokeWidth: 1 }} isAnimationActive={false} />
            {SERIES.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={t(`traffic.series.${s.key}`)}
                type="monotone"
                stroke={s.color}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={0.1}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{t("traffic.tableCaption", { name: environmentName })}</caption>
        <thead>
          <tr>
            <th>{t("traffic.hour")}</th>
            <th>{t("traffic.series.exposures")}</th>
            <th>{t("traffic.series.events")}</th>
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
  );
}
