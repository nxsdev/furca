import type { Experiment, StatsEngine } from "@furca/core/experiments/Experiment";
import type { Metric } from "@furca/core/metrics/Metric";
import type { MetricResult, MetricRole } from "@furca/core/results/ExperimentResult";
import { Link } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { INTERVAL_INSET, IntervalBar, liftDomain, liftTicks } from "~/components/charts/IntervalBar";
import { VariationSwatch } from "~/components/experiments/parts";
import { formatCi, formatCount, formatLift, formatMetricValue, formatPercent, formatPValue, metricUnit } from "./format";
import { VerdictLabel, verdictStyle } from "./verdict";

/** Title and hint live under `results:table.roles.<role>` */
const roles: ReadonlyArray<MetricRole> = ["primary", "secondary", "guardrail"];

/** Shared lift axis across every row: one domain for every IntervalBar, labeled in the column header */
function useAxis(metrics: ReadonlyArray<MetricResult>) {
  const domain = liftDomain(metrics.flatMap((m) => m.comparisons.map((c) => c.ci)));
  return { domain, ticks: liftTicks(domain) };
}

type Axis = ReturnType<typeof useAxis>;

function AxisHeader({ axis }: { axis: Axis }) {
  const [min, max] = axis.domain;
  return (
    <div className="relative h-4" style={{ marginInline: INTERVAL_INSET }} aria-hidden="true">
      {axis.ticks.map((t) => (
        <span
          key={t}
          className="absolute -translate-x-1/2 font-mono text-[11px] font-normal tabular text-muted"
          style={{ left: `${((t - min) / (max - min)) * 100}%` }}
        >
          {t === 0 ? "0" : formatLift(t).replace(".0%", "%")}
        </span>
      ))}
    </div>
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
  const { t } = useTranslation("results");
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
        <caption className="sr-only">{t("table.caption", { control: control?.name ?? t("table.controlFallback") })}</caption>
        <thead>
          <tr className="text-left text-meta text-muted [&>th]:border-b [&>th]:border-border [&>th]:px-2.5 [&>th]:py-2 [&>th]:font-medium [&>th]:whitespace-nowrap">
            <th scope="col" className="w-[22%] min-w-[11rem] pl-5!">{t("table.columns.metric")}</th>
            <th scope="col" className="min-w-[9.5rem]">{t("table.columns.variation")}</th>
            <th scope="col" className="text-right">{control?.name ?? t("table.controlHeader")}</th>
            <th scope="col" className="text-right">{t("table.columns.value")}</th>
            <th scope="col" className="text-right">{t("table.columns.lift")}</th>
            <th scope="col" className="w-[20%] min-w-[150px]">
              <span className="sr-only">{t("table.columns.intervalPlot")}</span>
              <AxisHeader axis={axis} />
            </th>
            <th scope="col" className="text-right">{engine === "bayesian" ? t("table.columns.chanceToWin") : t("table.columns.pValue")}</th>
            <th scope="col" className="pr-5!">{t("table.columns.result")}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => {
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
                    {t(`table.roles.${role}.title`)} <span className="font-normal text-muted">· {t(`table.roles.${role}.hint`)}</span>
                  </th>
                </tr>
                {group.map((result) => {
                  const metric = metrics.get(result.metricId);
                  const type = metric?.type ?? "mean";
                  const unit = metricUnit(metric);
                  const summary = new Map(result.variations.map((v) => [v.variationKey, v]));
                  const base = control === undefined ? undefined : summary.get(control.key);
                  const nameCell = (rowSpan: number) => (
                    <th scope="rowgroup" rowSpan={rowSpan} className="border-b border-border py-3 pr-3 pl-5 text-left align-top font-normal">
                      {metric === undefined ? (
                        <span className="text-muted">{t("table.deletedMetric")}</span>
                      ) : (
                        <Link to="/metrics/$metricId" params={{ metricId: metric.id }} className="font-medium hover:underline">
                          {metric.name}
                        </Link>
                      )}
                      <div className="mt-0.5 text-meta text-muted">
                        {t(`table.types.${type}`)}
                        {metric?.inverse === true && t("table.lowerIsBetter")}
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
                            {result.error ?? t("table.noComparisons")}
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
                          {base !== undefined && <span className="text-meta text-muted">{unit}</span>}
                          <div className="text-meta text-muted">{base === undefined ? "" : formatCount(base.users)}</div>
                        </td>
                        <td className="text-right font-mono tabular">
                          {v === undefined ? "–" : formatMetricValue(type, v.mean)}
                          {v !== undefined && <span className="text-meta text-muted">{unit}</span>}
                          <div className="text-meta text-muted">{v === undefined ? "" : formatCount(v.users)}</div>
                        </td>
                        <td className="text-right font-mono tabular whitespace-nowrap">
                          {/* Only significant lifts get weight and color; the rest are noise and read as such */}
                          <span className={tone === "text-muted" ? "text-muted" : `font-medium ${tone}`}>
                            {c.lift === null ? "–" : formatLift(c.lift)}
                          </span>
                          <div className="text-meta text-muted">{c.ci === null ? "" : formatCi(c.ci)}</div>
                        </td>
                        <td>
                          <IntervalBar
                            lift={c.lift}
                            ci={c.ci}
                            verdict={trusted ? c.verdict : "neutral"}
                            domain={axis.domain}
                            label={`${metric?.name ?? t("table.deletedMetric")}: ${t("table.versus", { variation: variationName(c.variationKey), control: control?.name ?? t("table.controlFallback") })}`}
                          />
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
                              {t("table.unreliable")}
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
  const { t } = useTranslation("results");
  const control = experiment.variations[0];
  return (
    <div className="md:hidden">
      {roles.map((role) => {
        const group = results.filter((r) => r.role === role);
        if (group.length === 0) return null;
        const title = t(`table.roles.${role}.title`);
        return (
          <section key={role} aria-label={title}>
            <h3 className="border-b border-border bg-surface-secondary px-5 py-1.5 text-meta font-medium">{title}</h3>
            <ul>
              {group.flatMap((result) => {
                const metric = metrics.get(result.metricId);
                const name = metric?.name ?? t("table.deletedMetric");
                const summary = new Map(result.variations.map((v) => [v.variationKey, v]));
                const base = control === undefined ? undefined : summary.get(control.key);
                if (result.error !== null || result.comparisons.length === 0)
                  return [
                    <li key={result.metricId} className="border-b border-border px-5 py-3 text-label">
                      <p className="font-medium">{name}</p>
                      <p className="mt-0.5 text-muted">{result.error ?? t("table.noComparisons")}</p>
                    </li>,
                  ];
                return result.comparisons.map((c) => {
                  const v = summary.get(c.variationKey);
                  const index = experiment.variations.findIndex((x) => x.key === c.variationKey);
                  const tone = trusted ? verdictStyle[c.verdict].text : "text-muted";
                  const evidence =
                    engine === "bayesian"
                      ? c.chanceToWin === null ? null : t("table.toWin", { percent: formatPercent(c.chanceToWin) })
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
                            {t("table.unreliable")}
                          </span>
                        )}
                      </div>
                      <p className="flex items-center gap-1.5 text-meta text-muted">
                        <VariationSwatch index={index} />
                        {t("table.versus", { variation: experiment.variations[index]?.name ?? c.variationKey, control: control?.name ?? t("table.controlFallback") })}
                      </p>
                      <p className="flex flex-wrap items-baseline gap-x-2 font-mono tabular">
                        <span className={tone === "text-muted" ? "text-muted" : `font-medium ${tone}`}>{c.lift === null ? "–" : formatLift(c.lift)}</span>
                        <span className="text-meta text-muted">{c.ci === null ? "" : formatCi(c.ci)}</span>
                        {evidence !== null && <span className="ml-auto text-meta text-muted">{evidence}</span>}
                      </p>
                      <IntervalBar
                        lift={c.lift}
                        ci={c.ci}
                        verdict={trusted ? c.verdict : "neutral"}
                        domain={axis.domain}
                        label={`${name}: ${t("table.versus", { variation: experiment.variations[index]?.name ?? c.variationKey, control: control?.name ?? t("table.controlFallback") })}`}
                      />
                      {base !== undefined && v !== undefined && metric !== undefined && (
                        <p className="font-mono text-meta text-muted tabular">
                          {formatMetricValue(metric.type, base.mean)} → {formatMetricValue(metric.type, v.mean)}
                          {metricUnit(metric)} ·{" "}
                          {t("table.usersPair", { base: formatCount(base.users), variation: formatCount(v.users) })}
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
