import { Skeleton } from "@heroui/react";
import type { VolumeBucket } from "@kuji/api/contract";
import { useQuery } from "@tanstack/react-query";
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
  const volume = useQuery(orpc.events.volume.queryOptions({ input: { environmentId } }));
  if (volume.isPending) return <Skeleton className="h-5 w-32 rounded-md" />;
  if (volume.isError) return <span className="text-muted">—</span>;
  const series = hourlySeries(volume.data);
  const totals = series.map((s) => s.events + s.exposures);
  const total = totals.reduce((a, b) => a + b, 0);
  const max = Math.max(...totals, 1);
  const label = `${formatCount(series.reduce((a, s) => a + s.events, 0))} events and ${formatCount(series.reduce((a, s) => a + s.exposures, 0))} exposures in the last 24 hours`;
  return (
    <span className="inline-flex items-center gap-3">
      <svg width="96" height="20" viewBox="0 0 96 20" role="img" aria-label={label} className="shrink-0">
        <title>{label}</title>
        {totals.map((t, i) => {
          const h = t === 0 ? 1 : Math.max(2, (t / max) * 20);
          return (
            <rect
              key={i}
              x={i * 4}
              y={20 - h}
              width="3"
              height={h}
              rx={t === 0 ? 0 : 1}
              className={t === 0 ? "fill-border" : "fill-muted"}
            />
          );
        })}
      </svg>
      <span className={`w-12 text-right font-mono tabular ${total === 0 ? "text-muted" : ""}`}>{formatCount(total)}</span>
    </span>
  );
}
