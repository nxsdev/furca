import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Metric } from "@furca/core/metrics/Metric";
import type { DimensionSlice } from "@furca/core/results/ExperimentResult";
import { Button, Label, ListBox, Select, Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle, RefreshCw, SplitSquareVertical } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { INTERVAL_INSET, IntervalBar, liftDomain, liftTicks } from "~/components/charts/IntervalBar";
import { VariationSwatch } from "~/components/experiments/parts";
import { EmptyState, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { errorMessage, orpc } from "~/lib/rpc";
import { formatCount, formatLift, formatList } from "./format";
import { VerdictLabel, verdictStyle } from "./verdict";

/** Bucket names produced by the analysis (see AnalysisSql) */
const OTHER = "(other)";
const NOT_SET = "(not set)";

/** Picker of the form `Select` used in panel headers */
function HeaderSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ id: string; label: string; mono?: boolean }>;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(k) => typeof k === "string" && onChange(k)} className="w-40 shrink-0 sm:w-48">
      <Label className="sr-only">{label}</Label>
      <Select.Trigger className="h-8">
        <Select.Value className="truncate text-label" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label} className={o.mono === true ? "font-mono text-label" : undefined}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * Current-phase results split by one recorded exposure attribute (computed on demand). Exploratory:
 * slices are never corrected for multiple comparisons, so the panel says so
 */
export function DimensionBreakdown({
  experiment,
  metrics,
  trusted,
}: {
  experiment: Experiment;
  metrics: ReadonlyMap<string, Metric>;
  /** false when data health fails: verdicts are withheld, like in the metrics table */
  trusted: boolean;
}) {
  const { t } = useTranslation("results");
  const [dimension, setDimension] = useState(experiment.dimensions[0] ?? "");
  const [metricId, setMetricId] = useState<string | null>(null);
  const query = useQuery({
    ...orpc.results.dimension.queryOptions({ input: { experimentId: experiment.id, dimension } }),
    enabled: dimension !== "",
    // Runs against the event store or warehouse each time: don't repeat it on every focus
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (experiment.dimensions.length === 0)
    return (
      <EmptyState
        icon={<SplitSquareVertical />}
        title={t("breakdown.emptyTitle")}
        description={
          <Trans
            t={t}
            i18nKey="breakdown.emptyDescription"
            components={{
              link: (
                <Link
                  to="/experiments/$experimentId"
                  params={{ experimentId: experiment.id }}
                  search={{ tab: "setup" }}
                  className="text-link hover:underline"
                />
              ),
            }}
          />
        }
      />
    );

  const result = query.data;
  // Default to the primary metric of the result
  const first = result?.slices[0]?.metrics ?? [];
  const selected = metricId ?? first.find((m) => m.role === "primary")?.metricId ?? first[0]?.metricId ?? null;
  const metricName = (id: string) => metrics.get(id)?.name ?? t("table.deletedMetric");

  return (
    <Panel>
      <PanelHeader
        title={t("breakdown.title")}
        description={
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
            {t("breakdown.exploratory")}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <HeaderSelect
              label={t("breakdown.dimension")}
              value={dimension}
              onChange={setDimension}
              options={experiment.dimensions.map((d) => ({ id: d, label: d, mono: true }))}
            />
            {first.length > 0 && selected !== null && (
              <HeaderSelect
                label={t("breakdown.metric")}
                value={selected}
                onChange={setMetricId}
                options={first.map((m) => ({ id: m.metricId, label: metricName(m.metricId) }))}
              />
            )}
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={t("breakdown.recompute")}
              onPress={() => void query.refetch()}
              isDisabled={query.isFetching}
              className="text-muted"
            >
              <RefreshCw className={`size-3.5 ${query.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
            </Button>
          </div>
        }
      />
      {query.isPending ? (
        <div className="flex flex-col gap-2 p-5" aria-busy="true" aria-label={t("breakdown.loading")}>
          <Skeleton className="h-6 rounded-md" />
          <Skeleton className="h-6 rounded-md" />
          <Skeleton className="h-6 w-2/3 rounded-md" />
        </div>
      ) : query.error !== null ? (
        <div className="p-5">
          <QueryError message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        </div>
      ) : result === undefined ? null : result.error !== null ? (
        <p role="alert" className="flex items-start gap-1.5 px-5 py-4 text-body text-muted">
          <AlertCircle className="mt-1 size-3.5 shrink-0 text-lose" aria-hidden="true" />
          {result.error}
        </p>
      ) : result.slices.length === 0 || selected === null ? (
        <p className="px-5 py-4 text-body text-muted">{t("breakdown.noData")}</p>
      ) : (
        <SliceTable experiment={experiment} slices={result.slices} metricId={selected} metricName={metricName} trusted={trusted} />
      )}
      {result !== undefined && (
        <p className="border-t border-border px-5 py-2 text-meta text-muted">
          <Trans t={t} i18nKey="breakdown.computed" components={{ time: <RelativeTime date={result.computedAt} /> }} />
        </p>
      )}
    </Panel>
  );
}

function SliceTable({
  experiment,
  slices,
  metricId,
  metricName,
  trusted,
}: {
  experiment: Experiment;
  slices: ReadonlyArray<DimensionSlice>;
  metricId: string;
  metricName: (id: string) => string;
  trusted: boolean;
}) {
  const { t } = useTranslation("results");
  const control = experiment.variations[0];
  const treatments = experiment.variations.length - 1;
  const rowsOf = (slice: DimensionSlice) => slice.metrics.find((m) => m.metricId === metricId);
  const domain = liftDomain(slices.flatMap((s) => rowsOf(s)?.comparisons.map((c) => c.ci) ?? []));
  const [min, max] = domain;
  const label = (value: string) => (value === OTHER ? t("breakdown.other") : value === NOT_SET ? t("breakdown.notSet") : value);
  const variationIndex = (key: string) => experiment.variations.findIndex((v) => v.key === key);
  const columns = treatments > 1 ? 5 : 4;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-label">
        <caption className="sr-only">{t("breakdown.caption", { metric: metricName(metricId), control: control?.name ?? t("table.controlFallback") })}</caption>
        <thead>
          <tr className="text-left text-meta text-muted [&>th]:border-b [&>th]:border-border [&>th]:px-2.5 [&>th]:py-2 [&>th]:font-medium [&>th]:whitespace-nowrap">
            <th scope="col" className="pl-5!">{t("breakdown.columns.value")}</th>
            <th scope="col" className="text-right">{t("breakdown.columns.users")}</th>
            {treatments > 1 && <th scope="col">{t("table.columns.variation")}</th>}
            <th scope="col" className="text-right">{t("table.columns.lift")}</th>
            <th scope="col" className="w-[30%] min-w-[150px]">
              <span className="sr-only">{t("table.columns.intervalPlot")}</span>
              <div className="relative h-4" style={{ marginInline: INTERVAL_INSET }} aria-hidden="true">
                {liftTicks(domain).map((tick) => (
                  <span
                    key={tick}
                    className="absolute -translate-x-1/2 font-mono text-[11px] font-normal tabular text-muted"
                    style={{ left: `${((tick - min) / (max - min)) * 100}%` }}
                  >
                    {tick === 0 ? "0" : formatLift(tick).replace(".0%", "%")}
                  </span>
                ))}
              </div>
            </th>
            <th scope="col" className="pr-5!">{t("table.columns.result")}</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((slice) => {
            const result = rowsOf(slice);
            const bucket = slice.value === OTHER || slice.value === NOT_SET;
            const valueCell = (rowSpan: number) => (
              <th scope="rowgroup" rowSpan={rowSpan} className="border-b border-border py-2.5 pr-3 pl-5 text-left align-middle font-normal">
                <span className={bucket ? "text-muted italic" : "font-mono"}>{label(slice.value)}</span>
              </th>
            );
            const usersCell = (rowSpan: number) => (
              <td rowSpan={rowSpan} className="border-b border-border px-2.5 text-right align-middle font-mono tabular">
                {formatCount(slice.users)}
              </td>
            );
            if (result === undefined || result.error !== null || result.comparisons.length === 0)
              return (
                <tr key={slice.value}>
                  {valueCell(1)}
                  {usersCell(1)}
                  <td colSpan={columns - 1} className="border-b border-border px-2.5 py-2.5 pr-5 text-muted">
                    {result?.error ?? t("table.noComparisons")}
                  </td>
                </tr>
              );
            return result.comparisons.map((c, i) => {
              const index = variationIndex(c.variationKey);
              const variation = experiment.variations[index]?.name ?? c.variationKey;
              const tone = trusted ? verdictStyle[c.verdict].text : "text-muted";
              // A slice that "wins" while a guardrail regresses there is a trade-off, never a plain win
              const regressed =
                c.verdict === "winning"
                  ? slice.metrics.filter(
                      (m) => m.role === "guardrail" && m.comparisons.some((g) => g.variationKey === c.variationKey && g.verdict === "losing"),
                    )
                  : [];
              return (
                <tr key={`${slice.value}:${c.variationKey}`} className="[&>td]:border-b [&>td]:border-border [&>td]:px-2.5 [&>td]:py-2 [&>td]:align-middle">
                  {i === 0 && valueCell(result.comparisons.length)}
                  {i === 0 && usersCell(result.comparisons.length)}
                  {treatments > 1 && (
                    <td>
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <VariationSwatch index={index} />
                        {variation}
                      </span>
                    </td>
                  )}
                  <td className={`text-right font-mono tabular ${tone}`}>{c.lift === null ? "–" : formatLift(c.lift)}</td>
                  <td>
                    <IntervalBar
                      lift={c.lift}
                      ci={c.ci}
                      verdict={trusted ? c.verdict : "neutral"}
                      domain={domain}
                      label={`${label(slice.value)}: ${t("table.versus", { variation, control: control?.name ?? t("table.controlFallback") })}`}
                    />
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
                    {trusted && regressed.length > 0 && (
                      <div className="inline-flex items-center gap-1 text-meta text-lose">
                        <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                        {t("breakdown.guardrailRegressed", { metrics: formatList(regressed.map((m) => metricName(m.metricId))) })}
                      </div>
                    )}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}
