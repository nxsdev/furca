import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import type { Metric } from "@furca/core/metrics/Metric";
import type { ExperimentHealth, MetricResult, ResultSnapshot } from "@furca/core/results/ExperimentResult";
import { Button, Label, ListBox, Select, Skeleton, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CircleCheck, CircleDashed, RefreshCw, ShieldAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { VariationSwatch, weightLabel } from "~/components/experiments/parts";
import { CodeBlock } from "~/components/flags/CodeBlock";
import { Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";
import { formatCount, formatLift, formatPercent, pText } from "./format";
import { LiftChart } from "./LiftChart";
import { MetricsTable } from "./MetricsTable";
import { headlineComparison, isHealthy, regressedGuardrails, verdictStyle } from "./verdict";

/** Results tab: verdict first, then health, then the evidence */
export function ResultsView({ experiment, feature }: { experiment: Experiment; feature: Feature | undefined }) {
  const queryClient = useQueryClient();
  const latestOptions = orpc.results.latest.queryOptions({ input: { experimentId: experiment.id } });
  const latest = useQuery(latestOptions);
  const metricsQuery = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: true } }));
  const refresh = useMutation(
    orpc.results.refresh.mutationOptions({
      onSuccess: (snapshot) => queryClient.setQueryData(latestOptions.queryKey, snapshot),
      onError: (error) => toast.danger("Could not refresh results", { description: errorMessage(error) }),
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
          <p className="font-medium">The analysis failed</p>
          <p className="mt-1 text-body text-muted">{snapshot.error ?? "Unknown error"}</p>
          <p className="mt-2 text-label text-muted">
            Previous results are not shown because they may be from different data. Fix the cause and refresh.
          </p>
          <Button size="sm" variant="outline" className="mt-3" onPress={onRefresh} isPending={refresh.isPending}>
            Try again
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
          title="Metrics"
          description={`Each variation compared with ${experiment.variations[0]?.name ?? "control"}. Intervals share one axis.`}
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
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading results">
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
  const phase = experiment.phases.length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-label text-muted">
        {snapshot === null ? "Not analyzed yet" : <>Updated <RelativeTime date={snapshot.computedAt} /></>}
        {phase > 1 && ` · Phase ${phase} only`}
        {experiment.status === "stopped" && experiment.stoppedAt !== null && " · Final results"}
      </p>
      {(experiment.status === "running" || snapshot === null) && (
        <Button size="sm" variant="outline" onPress={onRefresh} isPending={isPending}>
          <RefreshCw className={`size-3.5 ${isPending ? "animate-spin" : ""}`} aria-hidden="true" />
          {isPending ? "Analyzing…" : "Refresh"}
        </Button>
      )}
    </div>
  );
}

const methodText = (experiment: Experiment, primaryComparisons: number, secondaryComparisons: number): string => {
  const s = experiment.stats;
  // Mirrors the analysis: primary and secondary metrics are separate Holm families; guardrails are uncorrected
  const families = [
    primaryComparisons > 1 ? `primary across ${primaryComparisons} variations` : null,
    secondaryComparisons > 1 ? `${secondaryComparisons} secondary comparisons` : null,
  ].filter((f) => f !== null);
  const parts =
    s.engine === "bayesian"
      ? ["Bayesian: chance to win and credible intervals"]
      : [
          s.sequential ? "Sequential test: intervals stay valid however often you check" : "Fixed-horizon test: valid at the planned sample only",
          `α = ${s.alpha}`,
          s.correction === "holm" && families.length > 0 ? `Holm-corrected (${families.join(", ")})` : null,
        ];
  return [...parts, s.cuped ? "CUPED variance reduction" : null].filter((p) => p !== null).join(" · ");
};

function healthProblem(experiment: Experiment, health: ExperimentHealth): string {
  if (!health.srm.ok) {
    const total = health.srm.observed.reduce((a, b) => a + b, 0);
    const weightSum = health.srm.expectedWeights.reduce((a, b) => a + b, 0) || 1;
    const worst = health.srm.observed
      .map((o, i) => ({ i, o, e: ((health.srm.expectedWeights[i] ?? 0) / weightSum) * total }))
      .sort((a, b) => Math.abs(b.o - b.e) - Math.abs(a.o - a.e))[0];
    const name = worst === undefined ? "" : (experiment.variations[worst.i]?.name ?? `Variation ${worst.i}`);
    return worst === undefined
      ? "Sample ratio mismatch: users were not split as configured."
      : `Sample ratio mismatch: ${name} got ${formatCount(worst.o)} users where ${formatCount(worst.e)} were expected.`;
  }
  return `${formatPercent(multipleShare(health))} of users saw more than one variation.`;
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
  const health = snapshot.health;
  const primaryComparisons = primary?.comparisons.length ?? 0;
  const secondaryComparisons = snapshot.metrics
    .filter((m) => m.role === "secondary")
    .reduce((n, m) => n + m.comparisons.length, 0);
  const regressions = regressedGuardrails(snapshot.metrics);
  const plannedTotal =
    experiment.plan.sampleSizePerVariation === null ? null : experiment.plan.sampleSizePerVariation * experiment.variations.length;
  const progress = plannedTotal === null || health === null ? null : health.totalUsers / plannedTotal;
  const metricName = primary === undefined ? "primary metric" : (metrics.get(primary.metricId)?.name ?? "primary metric");
  const level = `${Math.round((1 - experiment.stats.alpha) * 100)}%`;
  const intervalName = experiment.stats.engine === "bayesian" ? "credible interval" : "CI";

  let tone: "win" | "lose" | "health" | "neutral" = "neutral";
  let icon: ReactNode = <CircleDashed className="size-5" />;
  let title: string;
  let detail: ReactNode = null;

  const comparison = primary === undefined ? null : headlineComparison(primary);
  const name = experiment.variations.find((v) => v.key === comparison?.variationKey)?.name ?? "Treatment";
  const control = experiment.variations[0]?.name ?? "Control";

  if (health !== null && !isHealthy(health)) {
    tone = "health";
    icon = <ShieldAlert className="size-5" />;
    title = "Results are not trustworthy";
    detail = <>{healthProblem(experiment, health)} Don't make a decision until the cause is fixed; see the health check below.</>;
  } else if (primary === undefined || comparison === null) {
    title = "No result for the primary metric";
    detail = primary?.error ?? "The analysis did not include the primary metric. Check that it is still set on the Setup tab.";
  } else if (primary.error !== null) {
    tone = "lose";
    icon = <AlertTriangle className="size-5" />;
    title = `${metricName} could not be analyzed`;
    detail = primary.error;
  } else {
    const lift = comparison.lift === null ? null : formatLift(comparison.lift);
    const ci =
      comparison.ci === null ? null : `${level} ${intervalName} ${formatLift(comparison.ci[0])} to ${formatLift(comparison.ci[1])}`;
    const evidence =
      experiment.stats.engine === "bayesian" && comparison.chanceToWin !== null
        ? `${formatPercent(comparison.chanceToWin)} chance to beat ${control}`
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
        title = regressions.length > 0 ? `${name} is winning, but a guardrail got worse` : `${name} is winning`;
        detail = figure;
        break;
      case "losing":
        tone = "lose";
        icon = <verdictStyle.losing.icon className="size-5" />;
        title = `${name} is losing`;
        detail = figure;
        break;
      case "neutral":
        title = progress !== null && progress >= 1 ? "No significant difference" : "No significant difference yet";
        detail = figure;
        break;
      default:
        title = "Not enough data yet";
        detail = comparison.message ?? "Keep the experiment running; the verdict appears once each variation has enough users.";
    }
  }

  const toneClass = {
    win: "border-win/40 [&_.verdict-icon]:text-win",
    lose: "border-lose/40 [&_.verdict-icon]:text-lose",
    health: "border-health/60 bg-health/5 [&_.verdict-icon]:text-health",
    neutral: "border-border [&_.verdict-icon]:text-muted",
  }[tone];

  return (
    <section aria-label="Verdict" className={`rounded-[10px] border bg-surface ${toneClass}`}>
      <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="verdict-icon mt-0.5 shrink-0">{icon}</span>
          <div className="min-w-0">
            <p className="text-meta text-muted">Primary metric</p>
            <h2 className="text-section font-semibold">{title}</h2>
            {detail !== null && <div className="mt-1 text-body text-muted [&_.text-body]:text-foreground">{detail}</div>}
          </div>
        </div>
        {health !== null && (
          <div className="shrink-0 sm:w-52 sm:text-right">
            <p className="text-body font-medium tabular">{formatCount(health.totalUsers)} users</p>
            {progress !== null && plannedTotal !== null ? (
              <>
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-default"
                  role="progressbar"
                  aria-label="Share of planned sample"
                  aria-valuenow={Math.round(Math.min(progress, 1) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.min(progress, 1) * 100}%` }} />
                </div>
                <p className="mt-1 text-meta text-muted">
                  {formatPercent(progress, 0)} of planned {formatCount(plannedTotal)}
                </p>
              </>
            ) : (
              <p className="text-meta text-muted">No sample size planned</p>
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
                  Guardrail regressed
                </span>
                <span>
                  {metrics.get(m.metricId)?.name ?? "Guardrail metric"}{" "}
                  <span className="tabular">{worst?.lift == null ? "" : formatLift(worst.lift)}</span>
                  {ci !== null && <span className="tabular text-muted"> [{formatLift(ci[0])}, {formatLift(ci[1])}]</span>}
                  <span className="text-muted"> · weigh this before shipping</span>
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

const srmCauses = [
  "A variation crashes, redirects or loads slower, so its exposure is never sent",
  "Exposures are logged on a code path only one variation reaches (log at flag evaluation instead)",
  "A rule above the experiment, a QA override or a cached payload assigns some users outside the split",
  "The SDK hashes a different attribute than the user id used for analysis (anonymous vs signed-in id)",
  "Bots or internal traffic are concentrated in one variation",
];

function HealthStrip({ experiment, health }: { experiment: Experiment; health: ExperimentHealth }) {
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
    <section aria-label="Data health" className={`rounded-[10px] border bg-surface ${srm.ok && health.multipleExposuresOk ? "border-border" : "border-health/60"}`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        {item(
          srm.pValue === null ? null : srm.ok,
          srm.pValue === null ? "Sample ratio" : srm.ok ? "Sample ratio OK" : "Sample ratio mismatch",
          srm.pValue === null ? "checked once each variation has users" : pText(srm.pValue),
        )}
        {item(
          health.multipleExposuresOk,
          health.multipleExposuresOk ? "Multiple exposures" : "Too many multiple exposures",
          `${formatPercent(share)} · ${formatCount(health.multipleExposureUsers)} excluded`,
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onPress={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide details" : "Details"}
        </Button>
      </div>
      {open && (
        <div className="grid gap-6 border-t border-border px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <h3 className="text-label font-medium">Users per variation</h3>
            <p className="mt-0.5 text-meta text-muted">
              Chi-square test against the configured split. Below p = 0.001 the assignment is broken and results are hidden as a
              verdict.
            </p>
            <table className="mt-3 w-full text-label">
              <thead>
                <tr className="text-meta text-muted [&>th]:pb-1.5 [&>th]:font-normal [&>th+th]:pl-3">
                  <th scope="col" className="text-left">Variation</th>
                  <th scope="col" className="text-right">Split</th>
                  <th scope="col" className="text-right">Expected</th>
                  <th scope="col" className="text-right">Observed</th>
                  <th scope="col" className="text-right">Diff</th>
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
                          {experiment.variations[i]?.name ?? `Variation ${i}`}
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
            <h3 className="text-label font-medium">{srm.ok ? "If this ever fails, check" : "Check these likely causes"}</h3>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-label text-muted marker:text-border">
              {srmCauses.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="mt-3 text-meta text-muted">
              Users who saw more than one variation are excluded from every metric; above 1% the experiment is flagged.
            </p>
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
  const usable = results.filter((r) => r.error === null);
  const [selected, setSelected] = useState(usable.find((r) => r.role === "primary")?.metricId ?? usable[0]?.metricId ?? null);
  const result = usable.find((r) => r.metricId === selected) ?? usable[0];
  if (result === undefined) return null;
  return (
    <Panel>
      <PanelHeader
        title="Cumulative lift"
        description="By first-exposure date. A line that keeps drifting suggests a novelty effect or a tracking change."
        actions={
          <Select
            aria-label="Metric"
            value={result.metricId}
            onChange={(k) => typeof k === "string" && setSelected(k)}
            className="w-44 shrink-0 sm:w-56"
          >
            <Label className="sr-only">Metric</Label>
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
        title={experiment.phases.length > 1 ? `Phase ${experiment.phases.length} has no exposures yet` : "Waiting for the first exposures"}
        description={`Results appear once users in ${env?.name ?? "the analysis environment"} evaluate ${flagKey}.`}
      />
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <CodeBlock code={snippet} title="Evaluate the flag with the SDK" />
        <ol className="flex flex-col gap-4 text-label">
          {[
            ["Users get assigned", `Each user is hashed on "${experiment.hashAttribute}" into a variation; the same user always gets the same one.`],
            ["Exposures arrive", "The SDK batches exposures to furca. Bots and duplicate exposures are filtered out."],
            [
              "Refresh to analyze",
              "Health checks run first. The verdict appears once each variation has enough users for the primary metric.",
            ],
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
