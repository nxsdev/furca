import { Skeleton } from "@heroui/react";
import type { VolumeBucket } from "@furca/api/contract";
import { barY, defineChart } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatCount } from "~/components/results/format";
import { orpc } from "~/lib/rpc";

const HOUR = 3_600_000;

/** 512 B, 14.2 KB, 1.31 MB, 2.4 GB */
export const formatBytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
};

/** The last 24 UTC hours oldest first, zero-filled (the API omits empty hours) */
export const hourlySeries = (buckets: ReadonlyArray<VolumeBucket>, now = Date.now()) => {
  const byHour = new Map(buckets.map((b) => [new Date(b.hour).getTime(), b]));
  const last = Math.floor(now / HOUR) * HOUR;
  return Array.from({ length: 24 }, (_, i) => {
    const hour = last - (23 - i) * HOUR;
    const b = byHour.get(hour);
    return { hour: new Date(hour), exposures: b?.exposures ?? 0, events: b?.events ?? 0 };
  });
};

/** 24 hourly bars of SDK traffic (events + exposures) with the total beside it */
export function TrafficSparkline({ environmentId }: { environmentId: string }) {
  const { t } = useTranslation("environments");
  const volume = useQuery(orpc.events.volume.queryOptions({ input: { environmentId } }));
  const series = useMemo(() => (volume.data === undefined ? [] : hourlySeries(volume.data)), [volume.data]);
  const definition = useMemo(() => {
    const rows = series.map((s) => ({ hour: s.hour.getTime(), total: s.events + s.exposures }));
    const max = Math.max(1, ...rows.map((r) => r.total));
    const bar = { x: "hour", inset: 0.5, radius: 1 } as const;
    // ponytail: empty hours keep a 1px stub in the border color and quiet hours a visible minimum, like a status strip
    return defineChart({
      marks: [
        barY(rows.filter((r) => r.total === 0), { ...bar, y: () => max / 20, fill: "var(--border)", radius: 0 }),
        barY(rows.filter((r) => r.total > 0), { ...bar, y: (r) => Math.max(r.total, max / 10), fill: "var(--muted)" }),
      ],
      scales: {
        x: { scale: scaleBand<number>().domain(rows.map((r) => r.hour)).padding(0.25) },
        y: { scale: scaleLinear().domain([0, max]) },
      },
      guides: false,
      margin: 0,
      pointer: false,
      keyboard: false,
    });
  }, [series]);
  if (volume.isPending) return <Skeleton className="h-5 w-32 rounded-md" />;
  if (volume.isError) return <span className="text-muted">—</span>;
  const total = series.reduce((a, s) => a + s.events + s.exposures, 0);
  const label = t(($) => $.sparkline.label, {
    events: formatCount(series.reduce((a, s) => a + s.events, 0)),
    exposures: formatCount(series.reduce((a, s) => a + s.exposures, 0)),
  });
  return (
    <span className="inline-flex items-center gap-3">
      <Chart definition={definition} width={96} height={20} ariaLabel={label} className="shrink-0" />
      <span className={`w-12 text-right font-mono tabular ${total === 0 ? "text-muted" : ""}`}>{formatCount(total)}</span>
    </span>
  );
}
