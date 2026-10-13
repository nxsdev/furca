import { Breadcrumbs, buttonVariants, Switch } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChartLine, Plus } from "lucide-react";
import { useState } from "react";
import { Direction, metricTypeLabel, usageByMetric, windowLabel } from "~/components/metrics/describe";
import { MetricForm } from "~/components/metrics/MetricForm";
import { EmptyState, ListSkeleton, PageHeader, Panel, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/metrics/")({
  validateSearch: (s: Record<string, unknown>): { new?: true } => (s.new ? { new: true } : {}),
  head: () => ({ meta: [{ title: "Metrics · kuji" }] }),
  component: Page,
});

function Page() {
  const { new: isNew } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (isNew)
    return (
      <>
        <PageHeader
          breadcrumb={
            <Breadcrumbs className="mb-1 text-label">
              <Breadcrumbs.Item href="/metrics">Metrics</Breadcrumbs.Item>
              <Breadcrumbs.Item>New</Breadcrumbs.Item>
            </Breadcrumbs>
          }
          title="New metric"
          description="Turn events into the number an experiment is judged by."
        />
        <MetricForm
          onSaved={(m) => void navigate({ to: "/metrics/$metricId", params: { metricId: m.id } })}
          onCancel={() => void navigate({ search: {} })}
        />
      </>
    );
  return <MetricList />;
}

function MetricList() {
  const [showArchived, setShowArchived] = useState(false);
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: showArchived } }));
  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const usage = usageByMetric(experiments.data ?? []);
  const sourceName = (id: string) => sources.data?.find((s) => s.id === id)?.name ?? (id === "builtin" ? "Built-in events" : "—");

  const newButton = (
    <Link to="/metrics" search={{ new: true }} className={buttonVariants({ size: "sm" })}>
      <Plus className="size-4" />
      New metric
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Metrics"
        description="Reusable definitions of what success means. Experiments pick them as primary, secondary or guardrail metrics."
        actions={newButton}
      />
      {metrics.isPending ? (
        <Panel>
          <ListSkeleton />
        </Panel>
      ) : metrics.isError ? (
        <QueryError message={`Couldn't load metrics. ${errorMessage(metrics.error)}`} onRetry={() => metrics.refetch()} />
      ) : metrics.data.length === 0 && !showArchived ? (
        <EmptyState
          icon={<ChartLine />}
          title="No metrics yet"
          description="A metric turns events into a number an experiment is judged by, like checkout conversion or revenue per user. Start from events your app sends with track()."
          action={newButton}
        />
      ) : (
        <Panel>
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
            <p className="text-label text-muted tabular">
              {metrics.data.length} {metrics.data.length === 1 ? "metric" : "metrics"}
            </p>
            <Switch size="sm" isSelected={showArchived} onChange={setShowArchived} className="[--switch-control-bg:oklch(0.9_0_0)] dark:[--switch-control-bg:var(--default)]">
              <Switch.Content className="text-label text-muted">
                <Switch.Control>
                  <Switch.Thumb className={showArchived ? "" : "dark:bg-[oklch(0.62_0_0)]"} />
                </Switch.Control>
                Show archived
              </Switch.Content>
            </Switch>
          </div>
          <div className="overflow-x-auto">
            <table className={tbl.table}>
              <thead>
                <tr>
                  <th className={tbl.th}>Metric</th>
                  <th className={tbl.th}>Type</th>
                  <th className={`${tbl.th} hidden md:table-cell`}>Data source</th>
                  <th className={`${tbl.th} hidden sm:table-cell`}>Goal</th>
                  <th className={`${tbl.th} hidden lg:table-cell`}>Window</th>
                  <th className={`${tbl.th} text-right`}>Used by</th>
                </tr>
              </thead>
              <tbody>
                {metrics.data.map((m) => {
                  const used = usage.get(m.id)?.length ?? 0;
                  return (
                    <tr key={m.id} className={tbl.tr}>
                      <td className={`${tbl.td} max-w-[320px] py-2`}>
                        <Link to="/metrics/$metricId" params={{ metricId: m.id }} className={`${tbl.rowLink} block truncate`}>
                          {m.name}
                        </Link>
                        <span className="flex items-center gap-2">
                          <code className="truncate font-mono text-meta text-muted">{m.key}</code>
                          {m.archived && <span className="text-meta text-muted">· Archived</span>}
                        </span>
                      </td>
                      <td className={tbl.td}>{metricTypeLabel[m.type]}</td>
                      <td className={`${tbl.td} hidden max-w-[200px] truncate md:table-cell`}>{sourceName(m.dataSourceId)}</td>
                      <td className={`${tbl.td} hidden sm:table-cell`}>
                        <Direction inverse={m.inverse} />
                      </td>
                      <td
                        className={`${tbl.td} hidden whitespace-nowrap lg:table-cell ${m.windowHours === null ? "text-muted" : "font-mono tabular"}`}
                      >
                        {m.windowHours === null && m.delayHours === 0 ? "None" : windowLabel(m)}
                      </td>
                      <td className={`${tbl.td} whitespace-nowrap text-right tabular ${used === 0 ? "text-muted" : ""}`}>
                        {experiments.isError ? (
                          "—"
                        ) : (
                          <>
                            <span className="font-mono sm:hidden">{used}</span>
                            <span className="hidden sm:inline">
                              {used === 0 ? "None" : `${used} ${used === 1 ? "experiment" : "experiments"}`}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {metrics.data.length === 0 && <p className="px-5 py-10 text-center text-body text-muted">No archived metrics.</p>}
          </div>
        </Panel>
      )}
    </>
  );
}
