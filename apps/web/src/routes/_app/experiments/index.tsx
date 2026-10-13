import type { Experiment, ExperimentStatus } from "@kuji/core/experiments/Experiment";
import type { ResultSnapshot } from "@kuji/core/results/ExperimentResult";
import { Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, ChartLine, Code2, Flag, FlaskConical, Plus } from "lucide-react";
import { DecisionBadge, StatusBadge } from "~/components/experiments/parts";
import { formatCount, formatDuration, formatLift } from "~/components/results/format";
import { headlineComparison, isHealthy, regressedGuardrails, verdictStyle } from "~/components/results/verdict";
import { Panel, PageHeader, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { errorMessage, orpc } from "~/lib/rpc";

type Filter = ExperimentStatus | "all";
const filters: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "running", label: "Running" },
  { id: "draft", label: "Draft" },
  { id: "stopped", label: "Stopped" },
  { id: "all", label: "All" },
];

export const Route = createFileRoute("/_app/experiments/")({
  head: () => ({ meta: [{ title: "Experiments · kuji" }] }),
  validateSearch: (search: Record<string, unknown>): { status?: Filter } =>
    filters.some((f) => f.id === search.status) ? { status: search.status as Filter } : {},
  component: Page,
});

const newButton = (
  <Link to="/experiments/new" className="button button--primary button--sm">
    <Plus className="size-4" aria-hidden="true" />
    New experiment
  </Link>
);

function Page() {
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
        title="Experiments"
        description="Hypotheses running on your flags, and whether they are winning."
        actions={all.length > 0 ? newButton : undefined}
      />
      {experiments.error !== null ? (
        <QueryError message={errorMessage(experiments.error)} onRetry={() => experiments.refetch()} />
      ) : experiments.isPending ? (
        <Panel>
          <div className="flex flex-col gap-4 p-5" aria-busy="true" aria-label="Loading experiments">
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
          <nav aria-label="Filter by status" className="flex w-fit rounded-lg border border-border bg-surface p-0.5">
            {filters.map((f) => (
              <Link
                key={f.id}
                to="/experiments"
                search={f.id === "all" ? {} : { status: f.id }}
                aria-current={status === f.id ? "page" : undefined}
                className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-label outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus ${
                  status === f.id ? "bg-default font-medium text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {f.label}
                <span className="font-mono text-meta tabular text-muted">{count(f.id)}</span>
              </Link>
            ))}
          </nav>
          <Panel className="overflow-hidden">
            {rows.length === 0 ? (
              <p className="px-5 py-12 text-center text-body text-muted">
                No {status} experiments.{" "}
                <Link to="/experiments" className="text-link hover:underline">
                  Show all
                </Link>
              </p>
            ) : (
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th scope="col" className={tbl.th}>Experiment</th>
                    <th scope="col" className={`${tbl.th} hidden sm:table-cell`}>Status</th>
                    <th scope="col" className={`${tbl.th} hidden lg:table-cell`}>Flag</th>
                    <th scope="col" className={`${tbl.th} hidden xl:table-cell`}>Primary metric</th>
                    <th scope="col" className={tbl.th}>Result</th>
                    <th scope="col" className={`${tbl.th} hidden md:table-cell`}>Duration</th>
                    <th scope="col" className={`${tbl.th} hidden text-right md:table-cell`}>Users</th>
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
      <td className={`${tbl.td} w-full max-w-0 sm:w-[30%]`}>
        <Link to="/experiments/$experimentId" params={{ experimentId: x.id }} className={`${tbl.rowLink} block sm:truncate`}>
          {x.name}
        </Link>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-muted">
          <span className="shrink-0 sm:hidden">
            <StatusBadge status={x.status} />
          </span>
          <span className="truncate font-mono">{x.key}</span>
        </div>
      </td>
      <td className={`${tbl.td} hidden sm:table-cell`}>
        <StatusBadge status={x.status} />
      </td>
      <td className={`${tbl.td} hidden max-w-40 truncate font-mono text-meta lg:table-cell`}>
        {flagKey === undefined ? <span className="text-muted">–</span> : flagKey}
      </td>
      <td className={`${tbl.td} hidden max-w-48 truncate xl:table-cell`}>{metricName ?? <span className="text-muted">None</span>}</td>
      <td className={`${tbl.td} whitespace-nowrap`}>
        {!started ? (
          <span className="text-muted">Not started</span>
        ) : latest.isPending ? (
          <Skeleton className="h-4 w-24 rounded-md" />
        ) : (
          <ResultSummary snapshot={snapshot} />
        )}
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap md:table-cell`}>
        {x.status === "stopped" ? (
          <DecisionBadge experiment={x} />
        ) : x.status === "running" && x.startedAt !== null ? (
          <span className="tabular">{formatDuration(x.startedAt, new Date())}</span>
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

function ResultSummary({ snapshot }: { snapshot: ResultSnapshot | null }) {
  if (snapshot === null || snapshot.status === "error" || (snapshot.health?.totalUsers ?? 0) === 0) {
    return <span className="text-muted">{snapshot?.status === "error" ? "Analysis failed" : "Collecting data"}</span>;
  }
  if (!isHealthy(snapshot.health)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-health">
        <AlertTriangle className="size-3.5" aria-hidden="true" />
        <span className="text-foreground">Not trustworthy</span>
      </span>
    );
  }
  const primary = snapshot.metrics.find((m) => m.role === "primary");
  const c = primary === undefined ? null : headlineComparison(primary);
  if (c === null || c.lift === null || c.ci === null) return <span className="text-muted">Collecting data</span>;
  const s = verdictStyle[c.verdict];
  const Icon = s.icon;
  // Mini interval on its own symmetric axis around zero
  const reach = Math.max(Math.abs(c.ci[0]), Math.abs(c.ci[1]), 0.02);
  const x = (v: number) => 50 + (v / reach) * 46;
  return (
    <span className="inline-flex items-center gap-2" title={`${s.label}: ${formatLift(c.lift)} [${formatLift(c.ci[0])}, ${formatLift(c.ci[1])}]`}>
      <Icon className={`size-3.5 shrink-0 ${s.text}`} aria-hidden="true" />
      <span className={`w-14 font-mono tabular ${s.text === "text-muted" ? "" : s.text}`}>{formatLift(c.lift)}</span>
      <svg width="64" height="12" aria-hidden="true" className="hidden shrink-0 sm:block">
        <line x1="50%" x2="50%" y1="0" y2="12" className="stroke-border" />
        <rect x={`${x(c.ci[0])}%`} width={`${Math.max(x(c.ci[1]) - x(c.ci[0]), 2)}%`} y="4" height="4" rx="2" className={s.band} />
        <circle cx={`${x(c.lift)}%`} cy="6" r="2.5" className={s.fill} />
      </svg>
      <span className="sr-only">{s.label}</span>
      {regressedGuardrails(snapshot.metrics).length > 0 && (
        <span title="A guardrail metric got significantly worse" className="inline-flex items-center gap-1 text-lose">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Guardrail regressed</span>
        </span>
      )}
    </span>
  );
}

function EmptyLoop() {
  const steps = [
    { icon: Flag, title: "Flag", body: "Ship the change behind a flag." },
    { icon: FlaskConical, title: "Experiment", body: "Register the hypothesis, split and primary metric." },
    { icon: Code2, title: "Exposures", body: "The SDK logs who saw which variation." },
    { icon: ChartLine, title: "Results", body: "Decide to ship or roll back with trustworthy stats." },
  ];
  return (
    <div className="flex flex-col items-center gap-8 rounded-[10px] border border-dashed border-border px-6 py-14 text-center">
      <div className="flex max-w-[52ch] flex-col gap-1">
        <h2 className="text-section font-medium">Test a change before everyone gets it</h2>
        <p className="text-body text-muted">
          An experiment takes over one of your flags, splits users into variations and tells you which one moves your metric.
        </p>
      </div>
      <ol className="grid w-full max-w-3xl grid-cols-2 gap-4 text-left sm:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.title} className="relative flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-muted">
                <s.icon className="size-4" aria-hidden="true" />
              </span>
              {i < steps.length - 1 && <ArrowRight className="hidden size-3.5 text-border sm:block" aria-hidden="true" />}
            </div>
            <p className="text-label font-medium">
              <span className="font-mono text-muted">{i + 1}.</span> {s.title}
            </p>
            <p className="text-meta text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-center gap-2">
        {newButton}
        <Link to="/flags" className="button button--outline button--sm">
          Create a flag first
        </Link>
      </div>
    </div>
  );
}
