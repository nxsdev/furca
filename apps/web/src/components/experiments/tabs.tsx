import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import type { Metric } from "@furca/core/metrics/Metric";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Lock, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ValuePreview } from "~/components/flags/ValueInput";
import { formatCount, formatDateTime, formatDuration, formatList, formatPercent } from "~/components/results/format";
import { useConditionsSummary } from "~/components/targeting/ConditionBuilder";
import { ListSkeleton, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";
import { DraftSetup } from "./DraftSetup";
import { VariationSwatch, trafficOf, variationBg, weightLabel } from "./parts";

function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 px-5 py-4 text-label">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function MetricLinks({ ids, metrics }: { ids: ReadonlyArray<string>; metrics: ReadonlyMap<string, Metric> }) {
  const { t } = useTranslation(["experiments", "common"]);
  return ids.length === 0 ? (
    <span className="text-muted">{t("common:states.none")}</span>
  ) : (
    <span className="flex flex-col gap-0.5">
      {ids.map((id) => (
        <Link key={id} to="/metrics/$metricId" params={{ metricId: id }} className="w-fit truncate hover:underline">
          {metrics.get(id)?.name ?? t("setup.deletedMetric")}
        </Link>
      ))}
    </span>
  );
}

const num = <span className="font-mono tabular" />;

/** Drafts: editable summaries with a start checklist. Started: read-only, what was registered before the data arrived */
export function SetupView({ experiment, feature }: { experiment: Experiment; feature: Feature | undefined }) {
  return experiment.status === "draft" ? <DraftSetup experiment={experiment} feature={feature} /> : <RegisteredSetup experiment={experiment} feature={feature} />;
}

function RegisteredSetup({ experiment: x, feature }: { experiment: Experiment; feature: Feature | undefined }) {
  const { t } = useTranslation(["experiments", "common"]);
  const conditionsSummary = useConditionsSummary();
  const { environments } = useEnvironment();
  const metricsQuery = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: true } }));
  const metrics = new Map((metricsQuery.data ?? []).map((m) => [m.id, m]));
  const traffic = trafficOf(x);
  const started = x.status !== "draft";
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? t("setup.deletedEnvironment");
  const s = x.stats;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title={t("setup.hypothesis")} />
          <p className={`whitespace-pre-wrap px-5 py-4 text-body ${x.hypothesis.trim() === "" ? "text-muted" : ""}`}>
            {x.hypothesis.trim() === "" ? t("setup.noHypothesis") : x.hypothesis}
          </p>
        </Panel>
        <Panel className="overflow-hidden">
          <PanelHeader
            title={t("setup.variations")}
            description={
              <>
                {feature === undefined ? (
                  t("setup.valuesServedByFlag")
                ) : (
                  <Trans
                    t={t}
                    i18nKey="setup.valuesServedBy"
                    values={{ flag: feature.key }}
                    components={{ link: <Link to="/flags/$featureId" params={{ featureId: feature.id }} className="font-mono hover:underline" /> }}
                  />
                )}
                {started ? t("setup.currentWeights") : ""}
              </>
            }
          />
          <div className="overflow-x-auto">
            <table className={tbl.table}>
              <thead>
                <tr>
                  <th scope="col" className={tbl.th}>{t("setup.columns.variation")}</th>
                  <th scope="col" className={tbl.th}>{t("setup.columns.key")}</th>
                  <th scope="col" className={tbl.th}>{t("setup.columns.value")}</th>
                  <th scope="col" className={`${tbl.th} text-right`}>{t("setup.columns.weight")}</th>
                </tr>
              </thead>
              <tbody>
                {x.variations.map((v, i) => (
                  <tr key={v.key} className="border-b border-border last:border-b-0">
                    <td className={tbl.td}>
                      <span className="inline-flex items-center gap-2 font-medium">
                        <VariationSwatch index={i} />
                        {v.name}
                      </span>
                    </td>
                    <td className={`${tbl.td} font-mono text-meta text-muted`}>{v.key}</td>
                    <td className={`${tbl.td} max-w-[16rem]`}>
                      {feature === undefined ? <code className="font-mono">{v.value}</code> : <ValuePreview valueType={feature.valueType} value={v.value} />}
                    </td>
                    <td className={`${tbl.td} ${tbl.num}`}>{weightLabel(traffic.weights[i] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel>
          <PanelHeader title={t("setup.targeting")} />
          <Rows>
            <Row label={t("setup.whoCanEnter")}>{conditionsSummary(traffic.conditions)}</Row>
            <Row label={t("setup.coverage")}>
              <Trans t={t} i18nKey="setup.coverageValue" values={{ percent: formatPercent(traffic.coverage, 0) }} components={{ num }} />
            </Row>
            <Row label={t("setup.assignBy")}>
              <code className="font-mono">{x.hashAttribute}</code>
            </Row>
            <Row label={t("setup.runsIn")}>{formatList(x.environmentIds.map(envName)) || "–"}</Row>
            <Row label={t("setup.analyzedIn")}>{envName(x.analysisEnvironmentId)}</Row>
          </Rows>
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader title={t("setup.metrics")} />
          <Rows>
            <Row label={t("setup.primary")}>
              {x.primaryMetricId === null ? (
                <span className="text-muted">{t("setup.primaryMissing")}</span>
              ) : (
                <MetricLinks ids={[x.primaryMetricId]} metrics={metrics} />
              )}
            </Row>
            <Row label={t("setup.secondary")}>
              <MetricLinks ids={x.secondaryMetricIds} metrics={metrics} />
            </Row>
            <Row label={t("setup.guardrails")}>
              <MetricLinks ids={x.guardrailMetricIds} metrics={metrics} />
            </Row>
            <Row label={t("setup.breakdowns")}>
              {x.dimensions.length === 0 ? (
                <span className="text-muted">{t("setup.noBreakdowns")}</span>
              ) : (
                <span className="font-mono">{formatList(x.dimensions)}</span>
              )}
            </Row>
          </Rows>
        </Panel>
        <Panel>
          <PanelHeader
            title={t("setup.statistics")}
            description={
              started ? (
                <span className="inline-flex items-center gap-1">
                  <Lock className="size-3" aria-hidden="true" /> {t("setup.locked")}
                </span>
              ) : (
                t("setup.locksOnStart")
              )
            }
          />
          <Rows>
            <Row label={t("setup.engine")}>
              {s.engine === "bayesian" ? t("setup.bayesian") : s.sequential ? t("setup.sequential") : t("setup.fixed")}
            </Row>
            <Row label={t("setup.confidence")}>{Math.round((1 - s.alpha) * 100)}%</Row>
            <Row label="CUPED">{s.cuped ? t("setup.on") : t("setup.off")}</Row>
            {s.engine === "frequentist" && (
              <Row label={t("setup.correction")}>{s.correction === "holm" ? t("setup.holm") : t("common:states.none")}</Row>
            )}
            {s.engine === "frequentist" && s.sequential && (
              <Row label={t("setup.tunedFor")}>
                <Trans t={t} i18nKey="setup.tunedForValue" values={{ n: formatCount(s.sequentialTuning) }} components={{ num }} />
              </Row>
            )}
          </Rows>
        </Panel>
        {x.status === "running" ? (
          // Still editable while running: results show progress and an ETA once a plan exists
          <DraftSetup experiment={x} feature={feature} only="plan" />
        ) : (
          <Panel>
            <PanelHeader title={t("setup.plan")} />
            <Rows>
              <Row label={t("setup.detect")}>
                <Trans t={t} i18nKey="setup.detectValue" values={{ mde: formatPercent(x.plan.mde) }} components={{ num }} />
              </Row>
              <Row label={t("setup.perVariation")}>
                {x.plan.sampleSizePerVariation === null ? (
                  <span className="text-muted">{t("setup.notPlanned")}</span>
                ) : (
                  <span className="font-mono tabular">{formatCount(x.plan.sampleSizePerVariation)}</span>
                )}
              </Row>
              <Row label={t("setup.dailyUsers")}>
                {x.plan.dailyTraffic === null ? <span className="text-muted">–</span> : <span className="font-mono tabular">{formatCount(x.plan.dailyTraffic)}</span>}
              </Row>
            </Rows>
          </Panel>
        )}
      </div>
    </div>
  );
}

/** Timeline of traffic periods; each new phase re-randomizes users with a new seed */
export function PhasesView({ experiment: x }: { experiment: Experiment }) {
  const { t } = useTranslation("experiments");
  const conditionsSummary = useConditionsSummary();
  const phases = x.phases.map((p, i) => ({ p, i })).reverse();
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-2 text-label text-muted">
        <RotateCcw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {t("phases.intro")}
      </p>
      <Panel>
        <ol>
          {phases.map(({ p, i }) => {
            const current = i === x.phases.length - 1 && p.endedAt === null;
            const prev = x.phases[i - 1];
            const was = (changed: boolean, text: string) =>
              prev !== undefined && changed ? <span className="ml-2 font-sans text-meta text-muted">{t("phases.was", { value: text })}</span> : null;
            return (
              <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 border-b border-border px-5 py-4 last:border-b-0">
                <span
                  className={`mt-0.5 flex size-6 items-center justify-center rounded-full border font-mono text-meta tabular ${
                    current ? "border-foreground font-medium" : "border-border text-muted"
                  }`}
                >
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="text-body font-medium">
                      {t("phases.phase", { n: i + 1 })}
                      {current && <span className="ml-2 text-label font-normal text-muted">{t("phases.current")}</span>}
                    </p>
                    <p className="text-label text-muted tabular">
                      {formatDateTime(p.startedAt)} –{" "}
                      {p.endedAt === null ? t("phases.now") : formatDateTime(p.endedAt)} ·{" "}
                      {formatDuration(p.startedAt, p.endedAt ?? new Date())}
                    </p>
                  </div>
                  {p.reason !== "" && <p className="text-label">{p.reason}</p>}
                  <dl className="grid gap-x-6 gap-y-1.5 text-label sm:grid-cols-[auto_minmax(0,1fr)]">
                    <dt className="text-muted">{t("phases.split")}</dt>
                    <dd className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex h-1.5 w-full max-w-xs gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                        {p.weights.map((w, j) => (
                          <span key={j} className={variationBg[Math.min(j, 4)]} style={{ width: `${w * 100}%` }} />
                        ))}
                      </div>
                      <span className="flex flex-wrap gap-x-3 font-mono text-meta tabular">
                        {p.weights.map((w, j) => (
                          <span key={j} className="inline-flex items-center gap-1">
                            <VariationSwatch index={j} />
                            <span className="font-sans">{x.variations[j]?.name ?? t("phases.variationN", { n: j })}</span> {weightLabel(w)}
                          </span>
                        ))}
                        {was(
                          prev !== undefined && prev.weights.some((w, j) => Math.abs(w - (p.weights[j] ?? 0)) > 1e-9),
                          prev?.weights.map(weightLabel).join(" / ") ?? "",
                        )}
                      </span>
                    </dd>
                    <dt className="text-muted">{t("phases.coverage")}</dt>
                    <dd className="font-mono tabular">
                      {formatPercent(p.coverage, 0)}
                      {was(prev !== undefined && prev.coverage !== p.coverage, formatPercent(prev?.coverage ?? 0, 0))}
                    </dd>
                    <dt className="text-muted">{t("phases.targeting")}</dt>
                    <dd>
                      {conditionsSummary(p.conditions)}
                      {was(
                        prev !== undefined && JSON.stringify(prev.conditions) !== JSON.stringify(p.conditions),
                        conditionsSummary(prev?.conditions ?? []),
                      )}
                    </dd>
                    <dt className="text-muted">{t("phases.seed")}</dt>
                    <dd className="truncate font-mono text-meta">{p.seed}</dd>
                  </dl>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}

/** Audit action → key under `experiments:history.actions` */
const actionKey = {
  created: "created",
  updated: "updated",
  started: "started",
  "phase.started": "phaseStarted",
  "traffic.updated": "trafficUpdated",
  stopped: "stopped",
  archived: "archived",
  unarchived: "unarchived",
  deleted: "deleted",
} as const;

const parseJson = (s: string | null): Record<string, unknown> | null => {
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
};

const IGNORED = new Set(["updatedAt", "createdAt"]);

/** Audit trail for this experiment: who changed what, newest first */
export function HistoryView({ experiment }: { experiment: Experiment }) {
  const { t } = useTranslation("experiments");
  const audit = useQuery(
    orpc.audit.list.queryOptions({
      // ponytail: newest 100 only; add a "Load older" button with the `before` cursor if experiments get busier
      input: { entityType: "experiment", entityId: experiment.id, before: null, limit: 100 },
    }),
  );
  if (audit.isPending)
    return (
      <Panel>
        <ListSkeleton rows={4} />
      </Panel>
    );
  if (audit.error !== null) return <QueryError message={errorMessage(audit.error)} onRetry={() => audit.refetch()} />;
  if (audit.data.length === 0) return <p className="py-10 text-center text-body text-muted">{t("history.empty")}</p>;
  return (
    <Panel>
      <ol>
        {audit.data.map((log) => {
          const before = parseJson(log.before);
          const after = parseJson(log.after);
          const changed =
            before === null || after === null
              ? []
              : Object.keys(after).filter((k) => !IGNORED.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
          const key = Object.hasOwn(actionKey, log.action) ? actionKey[log.action as keyof typeof actionKey] : null;
          return (
            <li key={log.id} className="flex flex-col gap-1 border-b border-border px-5 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <p className="text-label">
                  <span className="font-medium">{log.actorEmail}</span> <span className="text-muted">{key === null ? log.action.toLowerCase() : t(`history.actions.${key}`)}</span>
                </p>
                <span className="text-meta text-muted">
                  <RelativeTime date={log.createdAt} />
                </span>
              </div>
              {changed.length > 0 && (
                <details className="text-meta">
                  <summary className="w-fit cursor-pointer text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
                    {/* ponytail: field names are the audit JSON keys spelled out, not translated */}
                    {t("history.changed", { fields: changed.map((k) => k.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ") })}
                  </summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {[
                      [t("history.before"), before],
                      [t("history.after"), after],
                    ].map(([label, obj]) => (
                      <div key={label as string} className="min-w-0">
                        <p className="mb-1 text-muted">{label as string}</p>
                        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-secondary p-2 font-mono text-[12px] leading-[1.5]">
                          {JSON.stringify(Object.fromEntries(changed.map((k) => [k, (obj as Record<string, unknown>)[k]])), null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
