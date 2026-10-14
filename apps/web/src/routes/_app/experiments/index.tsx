import type { Experiment, ExperimentStatus } from "@furca/core/experiments/Experiment";
import type { ResultSnapshot } from "@furca/core/results/ExperimentResult";
import { Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, ChartLine, Code2, Flag, FlaskConical, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "~/components/experiments/parts";
import { formatCount, formatDuration, formatLift } from "~/components/results/format";
import { headlineComparison, isHealthy, regressedGuardrails, verdictLabel, verdictStyle } from "~/components/results/verdict";
import { Panel, PageHeader, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { usePermissions } from "~/lib/permissions";
import { errorMessage, orpc } from "~/lib/rpc";

type Filter = ExperimentStatus | "all";
const filters: ReadonlyArray<Filter> = ["running", "draft", "stopped", "all"];

export const Route = createFileRoute("/_app/experiments/")({
  head: () => ({ meta: [{ title: i18n.t("experiments:pageTitle.list") }] }),
  validateSearch: (search: Record<string, unknown>): { status?: Filter } =>
    filters.includes(search.status as Filter) ? { status: search.status as Filter } : {},
  component: Page,
});

function NewButton() {
  const { t } = useTranslation("experiments");
  const { canEdit } = usePermissions();
  if (!canEdit) return null;
  return (
    <Link to="/experiments/new" className="button button--primary button--sm">
      <Plus className="size-4" aria-hidden="true" />
      {t("list.newExperiment")}
    </Link>
  );
}

function Page() {
  const { t } = useTranslation(["experiments", "common"]);
  const { status = "all" } = Route.useSearch();
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: true } }));
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: true } }));

  const all = experiments.data ?? [];
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((x) => x.status === f).length);
  const rows = all
    .filter((x) => status === "all" || x.status === status)
    .sort((a, b) => order(a) - order(b) || b.updatedAt.getTime() - a.updatedAt.getTime());
  const flagKey = new Map((features.data ?? []).map((f) => [f.id, f.key]));
  const metricName = new Map((metrics.data ?? []).map((m) => [m.id, m.name]));

  return (
    <>
      <PageHeader
        title={t("list.title")}
        description={t("list.description")}
        actions={all.length > 0 ? <NewButton /> : undefined}
      />
      {experiments.error !== null ? (
        <QueryError message={errorMessage(experiments.error)} onRetry={() => experiments.refetch()} />
      ) : experiments.isPending ? (
        <Panel>
          <div className="flex flex-col gap-4 p-5" aria-busy="true" aria-label={t("list.loading")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-6">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-48 rounded-md" />
                  <Skeleton className="h-3 w-28 rounded-md" />
                </div>
                <Skeleton className="hidden h-4 w-20 rounded-md sm:block" />
                <Skeleton className="h-4 w-24 rounded-md" />
              </div>
            ))}
          </div>
        </Panel>
      ) : all.length === 0 ? (
        <EmptyLoop />
      ) : (
        <div className="flex flex-col gap-4">
          <nav aria-label={t("list.filterLabel")} className="flex w-fit rounded-lg border border-border bg-surface p-0.5">
            {filters.map((f) => (
              <Link
                key={f}
                to="/experiments"
                search={f === "all" ? {} : { status: f }}
                aria-current={status === f ? "page" : undefined}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-label outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus ${
                  status === f ? "bg-default font-medium text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {f === "all" ? t("list.all") : t(`status.${f}`)}
                <span className="font-mono text-meta tabular text-muted">{count(f)}</span>
              </Link>
            ))}
          </nav>
          <Panel className="overflow-hidden">
            {rows.length === 0 ? (
              <p className="px-5 py-12 text-center text-body text-muted">
                {t(`list.empty.${status}`)}{" "}
                <Link to="/experiments" className="text-link hover:underline">
                  {t("list.showAll")}
                </Link>
              </p>
            ) : (
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th scope="col" className={tbl.th}>{t("list.columns.experiment")}</th>
                    <th scope="col" className={`${tbl.th} hidden sm:table-cell`}>{t("list.columns.status")}</th>
                    <th scope="col" className={`${tbl.th} hidden lg:table-cell`}>{t("list.columns.flag")}</th>
                    <th scope="col" className={`${tbl.th} hidden xl:table-cell`}>{t("list.columns.primaryMetric")}</th>
                    <th scope="col" className={tbl.th}>{t("list.columns.result")}</th>
                    <th scope="col" className={`${tbl.th} hidden md:table-cell`}>{t("list.columns.duration")}</th>
                    <th scope="col" className={`${tbl.th} hidden text-right md:table-cell`}>{t("list.columns.users")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <Row
                      key={x.id}
                      experiment={x}
                      flagKey={flagKey.get(x.featureId)}
                      metricName={x.primaryMetricId === null ? undefined : metricName.get(x.primaryMetricId)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

const order = (x: Experiment) => (x.status === "running" ? 0 : x.status === "draft" ? 1 : 2);

function Row({ experiment: x, flagKey, metricName }: { experiment: Experiment; flagKey?: string; metricName?: string }) {
  const { t } = useTranslation(["experiments", "common"]);
  const started = x.status !== "draft";
  const latest = useQuery({
    ...orpc.results.latest.queryOptions({ input: { experimentId: x.id } }),
    // ponytail: one request per started row; batch into experiments.list if lists grow past ~50 rows
    enabled: started,
    staleTime: 60_000,
  });
  const snapshot = latest.data ?? null;
  const users = snapshot?.health?.totalUsers ?? null;

  return (
    <tr className={tbl.tr}>
      {/* min-w keeps the name readable when other cells are wide; max-w-0 lets it take the remaining width and truncate */}
      <td className={`${tbl.td} w-full max-w-0 min-w-44 sm:w-[30%] lg:min-w-56`}>
        <Link to="/experiments/$experimentId" params={{ experimentId: x.id }} className={`${tbl.rowLink} block sm:truncate`} title={x.name}>
          {x.name}
        </Link>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-muted">
          <span className="shrink-0 sm:hidden">
            <StatusBadge status={x.status} />
          </span>
          <span className="truncate font-mono">{x.key}</span>
        </div>
      </td>
      <td className={`${tbl.td} hidden max-w-48 sm:table-cell`}>
        <StatusBadge status={x.status} />
        {/* The decision sits under "Stopped" as plain text: as a badge in its own column it pushed the name column to ~60px */}
        {x.status === "stopped" && x.decision !== null && <DecisionText experiment={x} />}
      </td>
      <td className={`${tbl.td} hidden max-w-40 truncate font-mono text-meta lg:table-cell`}>
        {flagKey === undefined ? <span className="text-muted">–</span> : flagKey}
      </td>
      <td className={`${tbl.td} hidden max-w-48 truncate xl:table-cell`}>{metricName ?? <span className="text-muted">{t("common:states.none")}</span>}</td>
      <td className={`${tbl.td} whitespace-nowrap`}>
        {!started ? (
          <span className="text-muted">{t("list.notStarted")}</span>
        ) : latest.isPending ? (
          <Skeleton className="h-4 w-24 rounded-md" />
        ) : (
          <ResultSummary snapshot={snapshot} />
        )}
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap md:table-cell`}>
        {x.startedAt !== null ? (
          <span className="tabular">{formatDuration(x.startedAt, x.stoppedAt ?? new Date())}</span>
        ) : (
          <span className="text-muted">–</span>
        )}
      </td>
      <td className={`${tbl.td} ${tbl.num} hidden md:table-cell`}>
        {users === null ? <span className="text-muted">–</span> : formatCount(users)}
      </td>
    </tr>
  );
}

/** "Shipped Treatment" / "Rolled back" / "Inconclusive" as one truncating line */
function DecisionText({ experiment: x }: { experiment: Experiment }) {
  const { t } = useTranslation("experiments");
  const d = x.decision;
  if (d === null) return null;
  const label =
    d.outcome === "ship"
      ? t("decision.shipped", { name: x.variations.find((v) => v.key === d.variationKey)?.name ?? d.variationKey ?? "" }).trim()
      : d.outcome === "rollback"
        ? t("decision.rolledBack")
        : t("decision.inconclusive");
  return (
    <p className="mt-0.5 truncate text-meta text-muted" title={label}>
      {label}
    </p>
  );
}

function ResultSummary({ snapshot }: { snapshot: ResultSnapshot | null }) {
  const { t } = useTranslation("experiments");
  if (snapshot === null || snapshot.status === "error" || (snapshot.health?.totalUsers ?? 0) === 0) {
    return <span className="text-muted">{snapshot?.status === "error" ? t("list.analysisFailed") : t("list.collectingData")}</span>;
  }
  if (!isHealthy(snapshot.health)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-health">
        <AlertTriangle className="size-3.5" aria-hidden="true" />
        <span className="text-foreground">{t("list.notTrustworthy")}</span>
      </span>
    );
  }
  const primary = snapshot.metrics.find((m) => m.role === "primary");
  const c = primary === undefined ? null : headlineComparison(primary);
  if (c === null || c.lift === null || c.ci === null) return <span className="text-muted">{t("list.collectingData")}</span>;
  const s = verdictStyle[c.verdict];
  const label = verdictLabel(c.verdict);
  const Icon = s.icon;
  // Mini interval on its own symmetric axis around zero
  const reach = Math.max(Math.abs(c.ci[0]), Math.abs(c.ci[1]), 0.02);
  const x = (v: number) => 50 + (v / reach) * 46;
  return (
    <span className="inline-flex items-center gap-2" title={`${label}: ${formatLift(c.lift)} [${formatLift(c.ci[0])}, ${formatLift(c.ci[1])}]`}>
      <Icon className={`size-3.5 shrink-0 ${s.text}`} aria-hidden="true" />
      <span className={`w-14 font-mono tabular ${s.text === "text-muted" ? "" : s.text}`}>{formatLift(c.lift)}</span>
      <svg width="64" height="12" aria-hidden="true" className="hidden shrink-0 sm:block">
        <line x1="50%" x2="50%" y1="0" y2="12" className="stroke-border" />
        <rect x={`${x(c.ci[0])}%`} width={`${Math.max(x(c.ci[1]) - x(c.ci[0]), 2)}%`} y="4" height="4" rx="2" className={s.band} />
        <circle cx={`${x(c.lift)}%`} cy="6" r="2.5" className={s.fill} />
      </svg>
      <span className="sr-only">{label}</span>
      {regressedGuardrails(snapshot.metrics).length > 0 && (
        <span title={t("list.guardrailWorse")} className="inline-flex items-center gap-1 text-lose">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{t("list.guardrailRegressed")}</span>
        </span>
      )}
    </span>
  );
}

function EmptyLoop() {
  const { t } = useTranslation("experiments");
  const steps = [
    { id: "flag", icon: Flag },
    { id: "experiment", icon: FlaskConical },
    { id: "exposures", icon: Code2 },
    { id: "results", icon: ChartLine },
  ] as const;
  return (
    <div className="flex flex-col items-center gap-8 rounded-[10px] border border-dashed border-border px-6 py-14 text-center">
      <div className="flex max-w-[52ch] flex-col gap-1">
        <h2 className="text-section font-medium">{t("list.emptyState.title")}</h2>
        <p className="text-body text-muted">{t("list.emptyState.description")}</p>
      </div>
      <ol className="grid w-full max-w-3xl grid-cols-2 gap-4 text-left sm:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.id} className="relative flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-muted">
                <s.icon className="size-4" aria-hidden="true" />
              </span>
              {i < steps.length - 1 && <ArrowRight className="hidden size-3.5 text-border sm:block" aria-hidden="true" />}
            </div>
            <p className="text-label font-medium">
              <span className="font-mono text-muted">{i + 1}.</span> {t(`list.emptyState.steps.${s.id}.title`)}
            </p>
            <p className="text-meta text-muted">{t(`list.emptyState.steps.${s.id}.body`)}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-center gap-2">
        <NewButton />
        <Link to="/flags" className="button button--outline button--sm">
          {t("list.emptyState.createFlagFirst")}
        </Link>
      </div>
    </div>
  );
}
