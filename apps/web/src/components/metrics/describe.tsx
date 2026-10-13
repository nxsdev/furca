import type { Experiment } from "@kuji/core/experiments/Experiment";
import type { Metric, MetricType } from "@kuji/core/metrics/Metric";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";

export const metricTypeLabel: Record<MetricType, string> = {
  proportion: "Conversion",
  mean: "Mean",
  ratio: "Ratio",
};

/** 24h, 72h, 7d, 14d */
export const formatHours = (hours: number): string =>
  hours >= 168 && hours % 24 === 0 ? `${hours / 24}d` : `${Number(hours.toFixed(2))}h`;

export const windowLabel = (m: Pick<Metric, "windowHours" | "delayHours">): string => {
  const window = m.windowHours === null ? "No window" : formatHours(m.windowHours);
  return m.delayHours > 0 ? `${window} · ${formatHours(m.delayHours)} delay` : window;
};

export const cappingLabel = (capping: Metric["capping"]): string =>
  capping.type === "none"
    ? "None"
    : capping.type === "absolute"
      ? `At ${capping.value} per user`
      : `At p${Number((capping.value * 100).toFixed(2))} per user`;

const Tok = ({ children }: { children: string }) => (
  <code className="rounded-[4px] bg-default px-1 py-px font-mono text-[0.92em]">{children}</code>
);

type Describable = Pick<Metric, "type" | "definition" | "windowHours" | "delayHours" | "capping">;

/**
 * The metric in one plain sentence, e.g. "Share of users with ≥1 `purchase` within 72h of first
 * exposure". Shared by the form preview, the list and the detail page so they never disagree
 */
export function MetricSentence({ metric }: { metric: Describable }) {
  const d = metric.definition;
  let what: ReactNode;
  if (d._tag === "event") {
    const ev = (name: string) => <Tok>{name.trim() === "" ? "event" : name.trim()}</Tok>;
    const agg = (s: { event: string; aggregation: "count" | "sum" }, first: boolean) =>
      s.aggregation === "count" ? (
        <>
          {first ? "Count" : "count"} of {ev(s.event)} events
        </>
      ) : (
        <>
          {first ? "Sum" : "sum"} of {ev(s.event)} values
        </>
      );
    if (metric.type === "proportion") what = <>Share of users with ≥1 {ev(d.numerator.event)}</>;
    else if (metric.type === "mean")
      what =
        d.numerator.aggregation === "count" ? (
          <>Average number of {ev(d.numerator.event)} events per user</>
        ) : (
          <>Average sum of {ev(d.numerator.event)} values per user</>
        );
    else
      what = (
        <>
          {agg(d.numerator, true)} ÷ {agg(d.denominator ?? { event: "", aggregation: "count" }, false)}, across users
        </>
      );
  } else {
    what =
      metric.type === "proportion" ? (
        <>Share of users with ≥1 row from the SQL</>
      ) : metric.type === "mean" ? (
        <>
          Average sum of <Tok>value</Tok> per user from the SQL
        </>
      ) : (
        <>
          Sum of numerator <Tok>value</Tok> ÷ sum of denominator <Tok>value</Tok>, across users
        </>
      );
  }

  const delay = metric.delayHours > 0 ? formatHours(metric.delayHours) : null;
  const when =
    metric.windowHours === null
      ? delay === null
        ? " any time after first exposure"
        : ` from ${delay} after first exposure on`
      : delay === null
        ? ` within ${formatHours(metric.windowHours)} of first exposure`
        : ` between ${delay} and ${formatHours(metric.windowHours)} after first exposure`;

  const cap =
    metric.type === "proportion" || metric.capping.type === "none"
      ? ""
      : metric.capping.type === "absolute"
        ? `, each user capped at ${metric.capping.value}`
        : `, each user capped at the ${Number((metric.capping.value * 100).toFixed(2))}th percentile`;

  return (
    <>
      {what}
      {when}
      {cap}.
    </>
  );
}

export function Direction({ inverse }: { inverse: boolean }) {
  const Icon = inverse ? ArrowDown : ArrowUp;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon className="size-3.5 text-muted" aria-hidden="true" />
      {inverse ? "Lower is better" : "Higher is better"}
    </span>
  );
}

/** Experiments that reference each metric (any role), keyed by metric id */
export const usageByMetric = (experiments: ReadonlyArray<Experiment>) => {
  const usage = new Map<string, Array<Experiment>>();
  for (const x of experiments) {
    const ids = new Set([x.primaryMetricId, ...x.secondaryMetricIds, ...x.guardrailMetricIds]);
    for (const id of ids) if (id !== null) usage.set(id, [...(usage.get(id) ?? []), x]);
  }
  return usage;
};
