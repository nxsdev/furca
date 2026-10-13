import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import type { Metric } from "@furca/core/metrics/Metric";
import type { ExperimentHealth, MetricResult, ResultSnapshot } from "@furca/core/results/ExperimentResult";
import { Button, Label, ListBox, Select, Skeleton, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CircleCheck, CircleDashed, RefreshCw, ShieldAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { VariationSwatch, weightLabel } from "~/components/experiments/parts";
import { CodeBlock } from "~/components/flags/CodeBlock";
import { Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";
import { i18n } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";
import { formatCount, formatLift, formatList, formatPercent, pText } from "./format";
import { LiftChart } from "./LiftChart";
import { MetricsTable } from "./MetricsTable";
import { headlineComparison, isHealthy, regressedGuardrails, verdictStyle } from "./verdict";

/** Results tab: verdict first, then health, then the evidence */
export function ResultsView({ experiment, feature }: { experiment: Experiment; feature: Feature | undefined }) {
  const { t } = useTranslation("results");
  const queryClient = useQueryClient();
  const latestOptions = orpc.results.latest.queryOptions({ input: { experimentId: experiment.id } });
  const latest = useQuery(latestOptions);
  const metricsQuery = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: true } }));
  const refresh = useMutation(
    orpc.results.refresh.mutationOptions({
      onSuccess: (snapshot) => queryClient.setQueryData(latestOptions.queryKey, snapshot),
      onError: (error) => toast.danger(i18n.t("results:view.refreshFailed"), { description: errorMessage(error) }),
    }),
  );
  const onRefresh = () => refresh.mutate({ experimentId: experiment.id });

  if (latest.isPending) return <ResultsSkeleton />;
  if (latest.error !== null) return <QueryError message={errorMessage(latest.error)} onRetry={() => latest.refetch()} />;

  const snapshot = latest.data;
  const metrics = new Map((metricsQuery.data ?? []).map((m) => [m.id, m]));
  const refreshBar = (
    <RefreshBar snapshot={snapshot} experiment={experiment} isPending={refresh.isPending} onRefresh={onRefresh} />
  );

  if (snapshot === null || (snapshot.status === "ok" && (snapshot.health?.totalUsers ?? 0) === 0)) {
    return (
      <div className="flex flex-col gap-4">
        {refreshBar}
        <WaitingForData experiment={experiment} feature={feature} metrics={metrics} />
      </div>
    );
  }

  if (snapshot.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        {refreshBar}
        <div role="alert" className="rounded-[10px] border border-danger/30 bg-danger/5 px-5 py-4">
          <p className="font-medium">{t("view.failedTitle")}</p>
          <p className="mt-1 text-body text-muted">{snapshot.error ?? t("view.unknownError")}</p>
          <p className="mt-2 text-label text-muted">{t("view.failedHelp")}</p>
          <Button size="sm" variant="outline" className="mt-3" onPress={onRefresh} isPending={refresh.isPending}>
            {t("view.tryAgain")}
          </Button>
        </div>
      </div>
    );
  }

  const primary = snapshot.metrics.find((m) => m.role === "primary");
  return (
    <div className="flex flex-col gap-4">
      {refreshBar}
      <VerdictBanner experiment={experiment} snapshot={snapshot} primary={primary} metrics={metrics} />
      {snapshot.health !== null && <HealthStrip experiment={experiment} health={snapshot.health} />}
      <Panel>
        <PanelHeader
          title={t("view.metricsTitle")}
          description={t("view.metricsDescription", { control: experiment.variations[0]?.name ?? t("view.controlFallback") })}
        />
        {metricsQuery.isPending ? (
          <div className="p-5">
            <Skeleton className="h-24 rounded-md" />
          </div>
        ) : (
          <MetricsTable
            experiment={experiment}
            results={snapshot.metrics}
            metrics={metrics}
            engine={experiment.stats.engine}
            trusted={isHealthy(snapshot.health)}
          />
        )}
      </Panel>
      <TrendPanel experiment={experiment} results={snapshot.metrics} metrics={metrics} />
    </div>
  );
}

function ResultsSkeleton() {
  const { t } = useTranslation("results");
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={t("view.loading")}>
      <Skeleton className="h-8 w-56 rounded-md" />
      <Skeleton className="h-32 rounded-[10px]" />
      <Skeleton className="h-12 rounded-[10px]" />
      <Skeleton className="h-64 rounded-[10px]" />
    </div>
  );
}

function RefreshBar({
  snapshot,
  experiment,
  isPending,
  onRefresh,
}: {
  snapshot: ResultSnapshot | null;
  experiment: Experiment;
  isPending: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation(["results", "common"]);
  const phase = experiment.phases.length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-label text-muted">
        {snapshot === null ? (
          t("view.notAnalyzed")
        ) : (
          <Trans t={t} i18nKey="view.updated" components={{ time: <RelativeTime date={snapshot.computedAt} /> }} />
        )}
        {phase > 1 && t("view.phaseOnly", { n: phase })}
        {experiment.status === "stopped" && experiment.stoppedAt !== null && t("view.final")}
      </p>
      {(experiment.status === "running" || snapshot === null) && (
        <Button size="sm" variant="outline" onPress={onRefresh} isPending={isPending}>
          <RefreshCw className={`size-3.5 ${isPending ? "animate-spin" : ""}`} aria-hidden="true" />
          {isPending ? t("view.analyzing") : t("common:actions.refresh")}
        </Button>
      )}
    </div>
  );
}

const methodText = (experiment: Experiment, primaryComparisons: number, secondaryComparisons: number): string => {
  const s = experiment.stats;
  // Mirrors the analysis: primary and secondary metrics are separate Holm families; guardrails are uncorrected
  const families = [
    primaryComparisons > 1 ? i18n.t("results:method.primaryAcross", { n: primaryComparisons }) : null,
    secondaryComparisons > 1 ? i18n.t("results:method.secondaryComparisons", { n: secondaryComparisons }) : null,
  ].filter((f) => f !== null);
  const parts =
    s.engine === "bayesian"
      ? [i18n.t("results:method.bayesian")]
      : [
          s.sequential ? i18n.t("results:method.sequential") : i18n.t("results:method.fixed"),
          `α = ${s.alpha}`,
          s.correction === "holm" && families.length > 0 ? i18n.t("results:method.holm", { families: formatList(families) }) : null,
        ];
  return [...parts, s.cuped ? i18n.t("results:method.cuped") : null].filter((p) => p !== null).join(" · ");
};

function healthProblem(experiment: Experiment, health: ExperimentHealth): string {
  if (!health.srm.ok) {
    const total = health.srm.observed.reduce((a, b) => a + b, 0);
    const weightSum = health.srm.expectedWeights.reduce((a, b) => a + b, 0) || 1;
    const worst = health.srm.observed
      .map((o, i) => ({ i, o, e: ((health.srm.expectedWeights[i] ?? 0) / weightSum) * total }))
      .sort((a, b) => Math.abs(b.o - b.e) - Math.abs(a.o - a.e))[0];
    if (worst === undefined) return i18n.t("results:health.srmGeneric");
    const name = experiment.variations[worst.i]?.name ?? i18n.t("results:health.variationN", { n: worst.i });
    return i18n.t("results:health.srmDetail", { name, observed: formatCount(worst.o), expected: formatCount(worst.e) });
  }
  return i18n.t("results:health.multipleShare", { percent: formatPercent(multipleShare(health)) });
}

const multipleShare = (h: ExperimentHealth) =>
  h.multipleExposureUsers / Math.max(1, h.totalUsers + h.multipleExposureUsers);

function VerdictBanner({
  experiment,
  snapshot,
  primary,
  metrics,
}: {
  experiment: Experiment;
  snapshot: ResultSnapshot;
  primary: MetricResult | undefined;
  metrics: ReadonlyMap<string, Metric>;
}) {
  const { t } = useTranslation("results");
  const health = snapshot.health;
  const primaryComparisons = primary?.comparisons.length ?? 0;
  const secondaryComparisons = snapshot.metrics
    .filter((m) => m.role === "secondary")
    .reduce((n, m) => n + m.comparisons.length, 0);
  const regressions = regressedGuardrails(snapshot.metrics);
  const plannedTotal =
    experiment.plan.sampleSizePerVariation === null ? null : experiment.plan.sampleSizePerVariation * experiment.variations.length;
  const progress = plannedTotal === null || health === null ? null : health.totalUsers / plannedTotal;
  const metricName = (primary === undefined ? undefined : metrics.get(primary.metricId)?.name) ?? t("banner.primaryFallback");
  const level = `${Math.round((1 - experiment.stats.alpha) * 100)}%`;

  let tone: "win" | "lose" | "health" | "neutral" = "neutral";
  let icon: ReactNode = <CircleDashed className="size-5" />;
  let title: string;
  let detail: ReactNode = null;

  const comparison = primary === undefined ? null : headlineComparison(primary);
  const name = experiment.variations.find((v) => v.key === comparison?.variationKey)?.name ?? t("banner.treatmentFallback");
  const control = experiment.variations[0]?.name ?? t("banner.controlFallback");

  if (health !== null && !isHealthy(health)) {
    tone = "health";
    icon = <ShieldAlert className="size-5" />;
    title = t("banner.untrustworthy");
    detail = t("banner.untrustworthyDetail", { problem: healthProblem(experiment, health) });
  } else if (primary === undefined || comparison === null) {
    title = t("banner.noPrimary");
    detail = primary?.error ?? t("banner.noPrimaryDetail");
  } else if (primary.error !== null) {
    tone = "lose";
    icon = <AlertTriangle className="size-5" />;
    title = t("banner.notAnalyzed", { metric: metricName });
    detail = primary.error;
  } else {
    const lift = comparison.lift === null ? null : formatLift(comparison.lift);
    const ci =
      comparison.ci === null
        ? null
        : t(experiment.stats.engine === "bayesian" ? "banner.ciBayesian" : "banner.ciFrequentist", {
            level,
            lo: formatLift(comparison.ci[0]),
            hi: formatLift(comparison.ci[1]),
          });
    const evidence =
      experiment.stats.engine === "bayesian" && comparison.chanceToWin !== null
        ? t("banner.chanceToBeat", { percent: formatPercent(comparison.chanceToWin), control })
        : comparison.pValue !== null
          ? pText(comparison.pValue)
          : null;
    const figure = (
      <>
        <span className={`text-figure font-semibold tracking-tight tabular ${comparison.verdict === "winning" ? "text-win" : comparison.verdict === "losing" ? "text-lose" : ""}`}>
          {lift ?? "–"}
        </span>{" "}
        <span className="text-body">{metricName}</span>
        <span className="block text-label text-muted">{[ci, evidence].filter(Boolean).join(" · ")}</span>
      </>
    );
    switch (comparison.verdict) {
      case "winning":
        // A guardrail regression turns a clear win into a trade-off the team has to weigh
        tone = regressions.length > 0 ? "health" : "win";
        icon = <verdictStyle.winning.icon className="size-5" />;
        title = regressions.length > 0 ? t("banner.winningWithRegression", { name }) : t("banner.winning", { name });
        detail = figure;
        break;
      case "losing":
        tone = "lose";
        icon = <verdictStyle.losing.icon className="size-5" />;
        title = t("banner.losing", { name });
        detail = figure;
        break;
      case "neutral":
        title = progress !== null && progress >= 1 ? t("banner.noDifference") : t("banner.noDifferenceYet");
        detail = figure;
        break;
      default:
        title = t("banner.notEnoughData");
        detail = comparison.message ?? t("banner.notEnoughDataDetail");
    }
  }

  const toneClass = {
    win: "border-win/40 [&_.verdict-icon]:text-win",
    lose: "border-lose/40 [&_.verdict-icon]:text-lose",
    health: "border-health/60 bg-health/5 [&_.verdict-icon]:text-health",
    neutral: "border-border [&_.verdict-icon]:text-muted",
  }[tone];

  return (
    <section aria-label={t("banner.label")} className={`rounded-[10px] border bg-surface ${toneClass}`}>
      <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="verdict-icon mt-0.5 shrink-0">{icon}</span>
          <div className="min-w-0">
            <p className="text-meta text-muted">{t("banner.primaryMetric")}</p>
            <h2 className="text-section font-semibold">{title}</h2>
            {detail !== null && <div className="mt-1 text-body text-muted [&_.text-body]:text-foreground">{detail}</div>}
          </div>
        </div>
        {health !== null && (
          <div className="shrink-0 sm:w-52 sm:text-right">
            <p className="text-body font-medium tabular">{t("users", { count: health.totalUsers, users: formatCount(health.totalUsers) })}</p>
            {progress !== null && plannedTotal !== null ? (
              <>
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-default"
                  role="progressbar"
                  aria-label={t("banner.progressLabel")}
                  aria-valuenow={Math.round(Math.min(progress, 1) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.min(progress, 1) * 100}%` }} />
                </div>
                <p className="mt-1 text-meta text-muted">
                  {t("banner.progress", { percent: formatPercent(progress, 0), total: formatCount(plannedTotal) })}
                </p>
              </>
            ) : (
              <p className="text-meta text-muted">{t("banner.noPlan")}</p>
            )}
          </div>
        )}
      </div>
      {isHealthy(health) && regressions.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-border px-5 py-3 text-label">
          {regressions.map((m) => {
            const worst = m.comparisons.find((c) => c.verdict === "losing");
            const ci = worst?.ci ?? null;
            return (
              <li key={m.metricId} className="flex flex-wrap items-baseline gap-x-2">
                <span className="inline-flex items-center gap-1 font-medium text-lose">
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                  {t("banner.guardrailRegressed")}
                </span>
                <span>
                  {metrics.get(m.metricId)?.name ?? t("banner.guardrailFallback")}{" "}
                  <span className="tabular">{worst?.lift == null ? "" : formatLift(worst.lift)}</span>
                  {ci !== null && <span className="tabular text-muted"> [{formatLift(ci[0])}, {formatLift(ci[1])}]</span>}
                  <span className="text-muted">{t("banner.weigh")}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-border px-5 py-2 text-meta text-muted">{methodText(experiment, primaryComparisons, secondaryComparisons)}</p>
    </section>
  );
}

/** Keys under `results:health.causes` */
const srmCauses = ["crash", "codePath", "override", "hashAttribute", "bots"] as const;

function HealthStrip({ experiment, health }: { experiment: Experiment; health: ExperimentHealth }) {
  const { t } = useTranslation("results");
  const srm = health.srm;
  const share = multipleShare(health);
  const total = srm.observed.reduce((a, b) => a + b, 0);
  const weightSum = srm.expectedWeights.reduce((a, b) => a + b, 0) || 1;
  const [open, setOpen] = useState(!srm.ok);

  const item = (ok: boolean | null, label: string, value: ReactNode) => (
    <div className="flex min-w-0 items-center gap-2">
      {ok === null ? (
        <CircleDashed className="size-4 shrink-0 text-muted" aria-hidden="true" />
      ) : ok ? (
        <CircleCheck className="size-4 shrink-0 text-muted" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-4 shrink-0 text-health" aria-hidden="true" />
      )}
      <span className="text-label">
        <span className={ok === false ? "font-medium" : ""}>{label}</span>{" "}
        <span className="text-muted">{value}</span>
      </span>
    </div>
  );

  return (
    <section aria-label={t("health.label")} className={`rounded-[10px] border bg-surface ${srm.ok && health.multipleExposuresOk ? "border-border" : "border-health/60"}`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        {item(
          srm.pValue === null ? null : srm.ok,
          srm.pValue === null ? t("health.sampleRatio") : srm.ok ? t("health.sampleRatioOk") : t("health.sampleRatioMismatch"),
          srm.pValue === null ? t("health.sampleRatioPending") : pText(srm.pValue),
        )}
        {item(
          health.multipleExposuresOk,
          health.multipleExposuresOk ? t("health.multipleExposures") : t("health.tooManyMultiple"),
          t("health.excluded", { percent: formatPercent(share), users: formatCount(health.multipleExposureUsers) }),
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onPress={() => setOpen(!open)} aria-expanded={open}>
          {open ? t("health.hideDetails") : t("health.details")}
        </Button>
      </div>
      {open && (
        <div className="grid gap-6 border-t border-border px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <h3 className="text-label font-medium">{t("health.usersPerVariation")}</h3>
            <p className="mt-0.5 text-meta text-muted">{t("health.chiSquare")}</p>
            <table className="mt-3 w-full text-label">
              <thead>
                <tr className="text-meta text-muted [&>th]:pb-1.5 [&>th]:font-normal [&>th+th]:pl-3">
                  <th scope="col" className="text-left">{t("health.columns.variation")}</th>
                  <th scope="col" className="text-right">{t("health.columns.split")}</th>
                  <th scope="col" className="text-right">{t("health.columns.expected")}</th>
                  <th scope="col" className="text-right">{t("health.columns.observed")}</th>
                  <th scope="col" className="text-right">{t("health.columns.diff")}</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular">
                {srm.observed.map((observed, i) => {
                  const w = (srm.expectedWeights[i] ?? 0) / weightSum;
                  const expected = w * total;
                  const diff = expected > 0 ? observed / expected - 1 : 0;
                  return (
                    <tr key={experiment.variations[i]?.key ?? i} className="border-t border-border [&>td]:py-1.5 [&>td+td]:pl-3">
                      <td className="font-sans">
                        <span className="inline-flex items-center gap-2">
                          <VariationSwatch index={i} />
                          {experiment.variations[i]?.name ?? t("health.variationN", { n: i })}
                        </span>
                      </td>
                      <td className="text-right">{weightLabel(w)}</td>
                      <td className="text-right">{formatCount(expected)}</td>
                      <td className="text-right">{formatCount(observed)}</td>
                      <td className={`text-right ${!srm.ok && Math.abs(diff) >= 0.01 ? "text-health" : "text-muted"}`}>{formatLift(diff)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-label font-medium">{srm.ok ? t("health.checkIfFails") : t("health.checkCauses")}</h3>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-label text-muted marker:text-border">
              {srmCauses.map((c) => (
                <li key={c}>{t(`health.causes.${c}`)}</li>
              ))}
            </ul>
            <p className="mt-3 text-meta text-muted">{t("health.multipleNote")}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function TrendPanel({
  experiment,
  results,
  metrics,
}: {
  experiment: Experiment;
  results: ReadonlyArray<MetricResult>;
  metrics: ReadonlyMap<string, Metric>;
}) {
  const { t } = useTranslation("results");
  const usable = results.filter((r) => r.error === null);
  const [selected, setSelected] = useState(usable.find((r) => r.role === "primary")?.metricId ?? usable[0]?.metricId ?? null);
  const result = usable.find((r) => r.metricId === selected) ?? usable[0];
  if (result === undefined) return null;
  return (
    <Panel>
      <PanelHeader
        title={t("trend.title")}
        description={t("trend.description")}
        actions={
          <Select
            aria-label={t("trend.metric")}
            value={result.metricId}
            onChange={(k) => typeof k === "string" && setSelected(k)}
            className="w-44 shrink-0 sm:w-56"
          >
            <Label className="sr-only">{t("trend.metric")}</Label>
            <Select.Trigger className="h-8">
              <Select.Value className="truncate text-label" />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {usable.map((r) => {
                  const label = metrics.get(r.metricId)?.name ?? r.metricId;
                  return (
                    <ListBox.Item key={r.metricId} id={r.metricId} textValue={label}>
                      {label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  );
                })}
              </ListBox>
            </Select.Popover>
          </Select>
        }
      />
      <LiftChart experiment={experiment} result={result} />
    </Panel>
  );
}

function WaitingForData({
  experiment,
  feature,
  metrics,
}: {
  experiment: Experiment;
  feature: Feature | undefined;
  metrics: ReadonlyMap<string, Metric>;
}) {
  const { t } = useTranslation("results");
  const { environments } = useEnvironment();
  const env = environments.find((e) => e.id === experiment.analysisEnvironmentId);
  const flagKey = feature?.key ?? "your-flag";
  const primary = experiment.primaryMetricId === null ? undefined : metrics.get(experiment.primaryMetricId);
  const event = primary?.definition._tag === "event" ? primary.definition.numerator.event : null;
  const fallback = feature === undefined ? "null" : feature.defaultValue;
  const read =
    feature?.valueType === "boolean"
      ? `if (furca.isOn("${flagKey}")) {\n  // ${experiment.variations[1]?.name ?? "treatment"} experience\n}`
      : `const value = furca.getValue("${flagKey}", ${fallback});`;
  const snippet = `import { createClient } from "@furca/sdk";

const furca = createClient({
  apiHost: "${typeof window === "undefined" ? "" : window.location.origin}",
  sdkKey: "${env?.sdkKey ?? "<sdk key>"}",
  attributes: { ${experiment.hashAttribute}: user.id },
});
await furca.ready();

// Evaluating the flag assigns a variation and sends the exposure
${read}
${event === null ? "" : `\n// Later, when the user converts\nfurca.track("${event}");`}`;

  return (
    <Panel>
      <PanelHeader
        title={experiment.phases.length > 1 ? t("waiting.phaseNoExposures", { n: experiment.phases.length }) : t("waiting.title")}
        description={t("waiting.description", { environment: env?.name ?? t("waiting.analysisEnvironment"), flag: flagKey })}
      />
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <CodeBlock code={snippet} title={t("waiting.codeTitle")} />
        <ol className="flex flex-col gap-4 text-label">
          {[
            [t("waiting.steps.assigned.title"), t("waiting.steps.assigned.body", { attribute: experiment.hashAttribute })],
            [t("waiting.steps.arrive.title"), t("waiting.steps.arrive.body")],
            [t("waiting.steps.refresh.title"), t("waiting.steps.refresh.body")],
          ].map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-meta tabular">
                {i + 1}
              </span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
