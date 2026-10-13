import type { Experiment, StatsEngine } from "@furca/core/experiments/Experiment";
import type { Metric } from "@furca/core/metrics/Metric";
import type { MetricResult, MetricRole, VariationComparison } from "@furca/core/results/ExperimentResult";
import { Link } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Fragment } from "react";
import { VariationSwatch } from "~/components/experiments/parts";
import { formatCi, formatCount, formatLift, formatMetricValue, formatPercent, formatPValue } from "./format";
import { VerdictLabel, verdictStyle } from "./verdict";

const roles: ReadonlyArray<{ role: MetricRole; title: string; hint: string }> = [
  { role: "primary", title: "Primary metric", hint: "Decides the experiment" },
  { role: "secondary", title: "Secondary metrics", hint: "Explain why the primary moved" },
  { role: "guardrail", title: "Guardrails", hint: "Must not get worse" },
];

/** Shared lift axis across every row: covers all intervals and zero, with nice ticks */
function useAxis(metrics: ReadonlyArray<MetricResult>) {
  const bounds = metrics.flatMap((m) => m.comparisons.flatMap((c) => (c.ci === null ? [] : [...c.ci])));
  // ponytail: clamp to ±100% so one wild early interval doesn't flatten every other row; clipped bars run to the edge
  const lo = Math.max(-1, Math.min(0, ...bounds));
  const hi = Math.min(1, Math.max(0, ...bounds));
  const span = Math.max(hi - lo, 0.02);
  const step = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5].find((s) => span / s <= 4) ?? 1;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: Array<number> = [];
  for (let t = min; t <= max + 1e-9; t += step) ticks.push(Number(t.toFixed(4)));
  const x = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min || 1)) * 100;
  return { ticks, x };
}

type Axis = ReturnType<typeof useAxis>;

function AxisHeader({ axis }: { axis: Axis }) {
  return (
    <div className="relative h-4" aria-hidden="true">
      {axis.ticks.map((t) => (
        <span
          key={t}
          className="absolute -translate-x-1/2 font-mono text-[11px] font-normal tabular text-muted"
          style={{ left: `${axis.x(t)}%` }}
        >
          {t === 0 ? "0" : formatLift(t).replace(".0%", "%")}
        </span>
      ))}
    </div>
  );
}

/** Interval bar + point estimate on the shared axis, colored by verdict */
export function CiPlot({ comparison, axis, trusted = true }: { comparison: VariationComparison; axis: Axis; trusted?: boolean }) {
  const s = verdictStyle[trusted ? comparison.verdict : "neutral"];
  const zero = axis.x(0);
  if (comparison.ci === null || comparison.lift === null) {
    return (
      <svg width="100%" height="24" aria-hidden="true" className="block">
        <line x1={`${zero}%`} x2={`${zero}%`} y1="0" y2="24" className="stroke-border" strokeWidth="1" />
      </svg>
    );
  }
  const [l, h] = comparison.ci.map(axis.x) as [number, number];
  return (
    <svg
      width="100%"
      height="24"
      role="img"
      aria-label={`Lift ${formatLift(comparison.lift)}, interval ${formatCi(comparison.ci)}`}
      className="block overflow-visible"
    >
      {axis.ticks.map((t) => (
        <line key={t} x1={`${axis.x(t)}%`} x2={`${axis.x(t)}%`} y1="2" y2="22" className="stroke-separator" strokeWidth="1" />
      ))}
      <line x1={`${zero}%`} x2={`${zero}%`} y1="0" y2="24" className="stroke-muted/60" strokeWidth="1" />
      <rect x={`${l}%`} width={`${Math.max(h - l, 0.5)}%`} y="8" height="8" rx="2" className={s.band} />
      <rect x={`${l}%`} width={`${Math.max(h - l, 0.5)}%`} y="11" height="2" className={s.fill} opacity="0.55" />
      <circle cx={`${axis.x(comparison.lift)}%`} cy="12" r="4" className={`${s.fill} stroke-surface`} strokeWidth="1.5" />
    </svg>
  );
}

export function MetricsTable({
  experiment,
  results,
  metrics,
  engine,
  trusted,
}: {
  experiment: Experiment;
  results: ReadonlyArray<MetricResult>;
  metrics: ReadonlyMap<string, Metric>;
  engine: StatsEngine;
  /** false when data health fails: verdicts are withheld and nothing is colored as a win or loss */
  trusted: boolean;
}) {
  const axis = useAxis(results);
  const variationIndex = new Map(experiment.variations.map((v, i) => [v.key, i]));
  const variationName = (key: string) => experiment.variations.find((v) => v.key === key)?.name ?? key;
  const control = experiment.variations[0];
  const columns = 7;

  return (
    <>
      <MobileList experiment={experiment} results={results} metrics={metrics} engine={engine} trusted={trusted} axis={axis} />
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[820px] border-separate border-spacing-0 text-label">
        <caption className="sr-only">Metric results by variation compared with {control?.name ?? "control"}</caption>
        <thead>
          <tr className="text-left text-meta text-muted [&>th]:border-b [&>th]:border-border [&>th]:px-2.5 [&>th]:py-2 [&>th]:font-medium [&>th]:whitespace-nowrap">
            <th scope="col" className="w-[22%] min-w-[11rem] pl-5!">Metric</th>
            <th scope="col" className="min-w-[9.5rem]">Variation</th>
            <th scope="col" className="text-right">{control?.name ?? "Control"}</th>
            <th scope="col" className="text-right">Value</th>
            <th scope="col" className="text-right">Lift</th>
            <th scope="col" className="w-[20%] min-w-[150px]">
              <span className="sr-only">Interval plot</span>
              <AxisHeader axis={axis} />
            </th>
            <th scope="col" className="text-right">{engine === "bayesian" ? "Chance to win" : "p-value"}</th>
            <th scope="col" className="pr-5!">Result</th>
          </tr>
        </thead>
        <tbody>
          {roles.map(({ role, title, hint }) => {
            const group = results.filter((r) => r.role === role);
            if (group.length === 0) return null;
            return (
              <Fragment key={role}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={columns + 1}
                    className="border-b border-border bg-surface-secondary px-5 py-1.5 text-left text-meta font-medium"
                  >
                    {title} <span className="font-normal text-muted">· {hint}</span>
                  </th>
                </tr>
                {group.map((result) => {
                  const metric = metrics.get(result.metricId);
                  const type = metric?.type ?? "mean";
                  const summary = new Map(result.variations.map((v) => [v.variationKey, v]));
                  const base = control === undefined ? undefined : summary.get(control.key);
                  const nameCell = (rowSpan: number) => (
                    <th scope="rowgroup" rowSpan={rowSpan} className="border-b border-border py-3 pr-3 pl-5 text-left align-top font-normal">
                      {metric === undefined ? (
                        <span className="text-muted">Deleted metric</span>
                      ) : (
                        <Link to="/metrics/$metricId" params={{ metricId: metric.id }} className="font-medium hover:underline">
                          {metric.name}
                        </Link>
                      )}
                      <div className="mt-0.5 text-meta text-muted">
                        {type === "proportion" ? "Conversion rate" : type === "ratio" ? "Ratio" : "Mean per user"}
                        {metric?.inverse === true && " · lower is better"}
                        {result.cupedApplied && " · CUPED"}
                      </div>
                    </th>
                  );
                  if (result.error !== null || result.comparisons.length === 0) {
                    return (
                      <tr key={result.metricId}>
                        {nameCell(1)}
                        <td colSpan={columns} className="border-b border-border px-3 py-3 pr-5 text-muted">
                          <span className="inline-flex items-start gap-1.5">
                            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-lose" aria-hidden="true" />
                            {result.error ?? "No comparisons were computed for this metric."}
                          </span>
                        </td>
                      </tr>
                    );
                  }
                  return result.comparisons.map((c, i) => {
                    const v = summary.get(c.variationKey);
                    const tone = trusted ? verdictStyle[c.verdict].text : "text-muted";
                    return (
                      <tr key={`${result.metricId}:${c.variationKey}`} className="[&>td]:border-b [&>td]:border-border [&>td]:px-2.5 [&>td]:py-2.5 [&>td]:align-middle">
                        {i === 0 && nameCell(result.comparisons.length)}
                        <td>
                          <span className="inline-flex max-w-[11rem] items-center gap-2">
                            <VariationSwatch index={variationIndex.get(c.variationKey) ?? 1} />
                            {variationName(c.variationKey)}
                          </span>
                        </td>
                        <td className="text-right font-mono tabular">
                          {base === undefined ? "–" : formatMetricValue(type, base.mean)}
                          <div className="text-meta text-muted">{base === undefined ? "" : formatCount(base.users)}</div>
                        </td>
                        <td className="text-right font-mono tabular">
                          {v === undefined ? "–" : formatMetricValue(type, v.mean)}
                          <div className="text-meta text-muted">{v === undefined ? "" : formatCount(v.users)}</div>
                        </td>
                        <td className="text-right font-mono tabular whitespace-nowrap">
                          <span className={`font-medium ${tone === "text-muted" ? "" : tone}`}>
                            {c.lift === null ? "–" : formatLift(c.lift)}
                          </span>
                          <div className="text-meta text-muted">{c.ci === null ? "" : formatCi(c.ci)}</div>
                        </td>
                        <td>
                          <CiPlot comparison={c} axis={axis} trusted={trusted} />
                        </td>
                        <td className="text-right font-mono tabular">
                          {engine === "bayesian"
                            ? c.chanceToWin === null
                              ? "–"
                              : formatPercent(c.chanceToWin)
                            : c.pValue === null
                              ? "–"
                              : formatPValue(c.pValue)}
                        </td>
                        <td className="pr-5!" title={c.message ?? undefined}>
                          {trusted ? (
                            <VerdictLabel verdict={c.verdict} />
                          ) : (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap text-label font-medium">
                              <AlertTriangle className="size-3.5 shrink-0 text-health" aria-hidden="true" />
                              Unreliable
                            </span>
                          )}
                          {c.message !== null && <div className="max-w-[18ch] truncate text-meta text-muted">{c.message}</div>}
                        </td>
                      </tr>
                    );
                  });
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

/** Below md the table becomes one block per comparison, verdict first */
function MobileList({
  experiment,
  results,
  metrics,
  engine,
  trusted,
  axis,
}: {
  experiment: Experiment;
  results: ReadonlyArray<MetricResult>;
  metrics: ReadonlyMap<string, Metric>;
  engine: StatsEngine;
  trusted: boolean;
  axis: Axis;
}) {
  const control = experiment.variations[0];
  return (
    <div className="md:hidden">
      {roles.map(({ role, title }) => {
        const group = results.filter((r) => r.role === role);
        if (group.length === 0) return null;
        return (
          <section key={role} aria-label={title}>
            <h3 className="border-b border-border bg-surface-secondary px-5 py-1.5 text-meta font-medium">{title}</h3>
            <ul>
              {group.flatMap((result) => {
                const metric = metrics.get(result.metricId);
                const name = metric?.name ?? "Deleted metric";
                const summary = new Map(result.variations.map((v) => [v.variationKey, v]));
                const base = control === undefined ? undefined : summary.get(control.key);
                if (result.error !== null || result.comparisons.length === 0)
                  return [
                    <li key={result.metricId} className="border-b border-border px-5 py-3 text-label">
                      <p className="font-medium">{name}</p>
                      <p className="mt-0.5 text-muted">{result.error ?? "No comparisons were computed for this metric."}</p>
                    </li>,
                  ];
                return result.comparisons.map((c) => {
                  const v = summary.get(c.variationKey);
                  const index = experiment.variations.findIndex((x) => x.key === c.variationKey);
                  const tone = trusted ? verdictStyle[c.verdict].text : "text-muted";
                  const evidence =
                    engine === "bayesian"
                      ? c.chanceToWin === null ? null : `${formatPercent(c.chanceToWin)} to win`
                      : c.pValue === null ? null : `p ${formatPValue(c.pValue)}`;
                  return (
                    <li key={`${result.metricId}:${c.variationKey}`} className="flex flex-col gap-1.5 border-b border-border px-5 py-3 text-label last:border-b-0">
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 font-medium">{name}</p>
                        {trusted ? (
                          <VerdictLabel verdict={c.verdict} />
                        ) : (
                          <span className="inline-flex shrink-0 items-center gap-1 font-medium">
                            <AlertTriangle className="size-3.5 text-health" aria-hidden="true" />
                            Unreliable
                          </span>
                        )}
                      </div>
                      <p className="flex items-center gap-1.5 text-meta text-muted">
                        <VariationSwatch index={index} />
                        {experiment.variations[index]?.name ?? c.variationKey} vs {control?.name ?? "control"}
                      </p>
                      <p className="flex flex-wrap items-baseline gap-x-2 font-mono tabular">
                        <span className={`font-medium ${tone === "text-muted" ? "" : tone}`}>{c.lift === null ? "–" : formatLift(c.lift)}</span>
                        <span className="text-meta text-muted">{c.ci === null ? "" : formatCi(c.ci)}</span>
                        {evidence !== null && <span className="ml-auto text-meta text-muted">{evidence}</span>}
                      </p>
                      <CiPlot comparison={c} axis={axis} trusted={trusted} />
                      {base !== undefined && v !== undefined && metric !== undefined && (
                        <p className="font-mono text-meta text-muted tabular">
                          {formatMetricValue(metric.type, base.mean)} → {formatMetricValue(metric.type, v.mean)} · {formatCount(base.users)} / {formatCount(v.users)} users
                        </p>
                      )}
                    </li>
                  );
                });
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
