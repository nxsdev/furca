import { Breadcrumbs, Button, buttonVariants, Skeleton, toast } from "@heroui/react";
import type { Metric } from "@kuji/core/metrics/Metric";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { AuditList } from "~/components/audit/AuditList";
import { StatusBadge } from "~/components/experiments/parts";
import { cappingLabel, Direction, formatHours, metricTypeLabel, MetricSentence, usageByMetric } from "~/components/metrics/describe";
import { MetricForm } from "~/components/metrics/MetricForm";
import { Code, ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/metrics/$metricId")({
  validateSearch: (s: Record<string, unknown>): { edit?: true } => (s.edit ? { edit: true } : {}),
  head: () => ({ meta: [{ title: "Metric · kuji" }] }),
  component: Page,
});

const crumbs = (name: ReactNode) => (
  <Breadcrumbs className="mb-1 text-label">
    <Breadcrumbs.Item href="/metrics">Metrics</Breadcrumbs.Item>
    <Breadcrumbs.Item>{name}</Breadcrumbs.Item>
  </Breadcrumbs>
);

function Page() {
  const { metricId } = Route.useParams();
  const metric = useQuery(orpc.metrics.get.queryOptions({ input: { id: metricId } }));

  if (metric.isPending)
    return (
      <>
        <div className="flex flex-col gap-2 pb-6">
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-7 w-64 rounded-md" />
          <Skeleton className="h-5 w-96 max-w-full rounded-md" />
        </div>
        <Panel>
          <ListSkeleton rows={6} />
        </Panel>
      </>
    );
  if (metric.isError)
    return (
      <>
        <PageHeader breadcrumb={crumbs("Metric")} title="Metric" />
        <QueryError message={`Couldn't load this metric. ${errorMessage(metric.error)}`} onRetry={() => metric.refetch()} />
      </>
    );
  return <MetricDetail metric={metric.data} />;
}

function MetricDetail({ metric }: { metric: Metric }) {
  const { edit } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const usedBy = usageByMetric(experiments.data ?? []).get(metric.id) ?? [];
  const running = usedBy.filter((x) => x.status === "running");
  const source = sources.data?.find((s) => s.id === metric.dataSourceId);

  const archive = useMutation(
    orpc.metrics.archive.mutationOptions({
      onSuccess: (m) => {
        void queryClient.invalidateQueries({ queryKey: orpc.metrics.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(m.archived ? "Metric archived" : "Metric restored", {
          description: m.archived ? "It's hidden from pickers. Experiments that use it keep it." : undefined,
        });
      },
      onError: (e) => toast.danger("Couldn't update the metric", { description: errorMessage(e) }),
    }),
  );

  if (edit)
    return (
      <>
        <PageHeader breadcrumb={crumbs(metric.name)} title={`Edit ${metric.name}`} />
        {running.length > 0 && (
          <p className="mb-4 rounded-[10px] border border-health/40 bg-health/8 px-4 py-3 text-body">
            {running.length === 1 ? "1 running experiment uses" : `${running.length} running experiments use`} this metric (
            {running.map((x) => x.name).join(", ")}). Changes apply from their next analysis.
          </p>
        )}
        <MetricForm
          metric={metric}
          onSaved={() => {
            toast.success("Metric saved");
            void navigate({ search: {} });
          }}
          onCancel={() => void navigate({ search: {} })}
        />
      </>
    );

  const d = metric.definition;
  const facts: Array<[string, ReactNode]> = [
    ["Key", <Code copy>{metric.key}</Code>],
    ["Type", metricTypeLabel[metric.type]],
    [
      "Data source",
      <Link
        to="/data-sources/$dataSourceId"
        params={{ dataSourceId: metric.dataSourceId }}
        className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        {source?.name ?? (metric.dataSourceId === "builtin" ? "Built-in events" : metric.dataSourceId)}
      </Link>,
    ],
    ...(d._tag === "event"
      ? ([
          [
            metric.type === "ratio" ? "Numerator" : "Event",
            <span className="font-mono">
              {d.numerator.event}
              {metric.type !== "proportion" && <span className="text-muted"> · {d.numerator.aggregation}</span>}
            </span>,
          ],
          ...(d.denominator !== null
            ? ([
                [
                  "Denominator",
                  <span className="font-mono">
                    {d.denominator.event}
                    <span className="text-muted"> · {d.denominator.aggregation}</span>
                  </span>,
                ],
              ] as Array<[string, ReactNode]>)
            : []),
        ] as Array<[string, ReactNode]>)
      : []),
    ["Window", metric.windowHours === null ? "None (until analysis time)" : formatHours(metric.windowHours)],
    ["Delay", metric.delayHours > 0 ? formatHours(metric.delayHours) : "None"],
    ...(metric.type !== "proportion" ? ([["Capping", cappingLabel(metric.capping)]] as Array<[string, ReactNode]>) : []),
    ["Goal", <Direction inverse={metric.inverse} />],
    ["Updated", <RelativeTime date={metric.updatedAt} />],
  ];

  return (
    <>
      <PageHeader
        breadcrumb={crumbs(metric.name)}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {metric.name}
            {metric.archived && (
              <span className="rounded-md border border-border px-2 py-0.5 text-label font-medium text-muted">Archived</span>
            )}
          </span>
        }
        description={metric.description || undefined}
        actions={
          <>
            <Button
              size="sm"
              variant="tertiary"
              isPending={archive.isPending}
              onPress={() => archive.mutate({ id: metric.id, archived: !metric.archived })}
            >
              {metric.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              {metric.archived ? "Restore" : "Archive"}
            </Button>
            <Link to="." search={{ edit: true }} className={buttonVariants({ size: "sm", variant: "secondary" })}>
              <Pencil className="size-4" />
              Edit
            </Link>
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Panel>
          <div className="border-b border-border px-5 py-5">
            <h2 className="text-meta font-medium text-muted">Definition</h2>
            <p className="mt-1.5 max-w-[70ch] text-section leading-relaxed">
              <MetricSentence metric={metric} />
            </p>
          </div>
          <dl className="grid gap-x-8 px-5 py-4 text-label sm:grid-cols-2">
            {facts.map(([k, v]) => (
              <div key={k} className="flex min-h-8 items-center gap-4 py-1">
                <dt className="w-28 shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 truncate">{v}</dd>
              </div>
            ))}
          </dl>
          {d._tag === "sql" && (
            <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
              {[
                [metric.type === "ratio" ? "Numerator SQL" : "SQL", d.numeratorSql] as const,
                ...(d.denominatorSql !== null ? ([["Denominator SQL", d.denominatorSql]] as const) : []),
              ].map(([label, sql]) => (
                <div key={label}>
                  <h3 className="mb-1.5 text-label text-muted">{label}</h3>
                  <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12px] leading-5">
                    {sql}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Used by" description="Experiments that read this metric. Results update at their next analysis." />
          {experiments.isPending ? (
            <ListSkeleton rows={2} />
          ) : experiments.isError ? (
            <div className="p-4">
              <QueryError message={`Couldn't load experiments. ${errorMessage(experiments.error)}`} onRetry={() => experiments.refetch()} />
            </div>
          ) : usedBy.length === 0 ? (
            <p className="px-5 py-6 text-body text-muted">
              No experiment uses this metric yet. Choose it as the primary metric when you{" "}
              <Link to="/experiments/new" className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
                create an experiment
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>Experiment</th>
                    <th className={tbl.th}>Status</th>
                    <th className={`${tbl.th} text-right`}>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {usedBy.map((x) => (
                    <tr key={x.id} className={tbl.tr}>
                      <td className={`${tbl.td} max-w-[360px] truncate`}>
                        <Link to="/experiments/$experimentId" params={{ experimentId: x.id }} className={tbl.rowLink}>
                          {x.name}
                        </Link>
                      </td>
                      <td className={tbl.td}>
                        <StatusBadge status={x.status} />
                      </td>
                      <td className={`${tbl.td} text-right text-muted`}>
                        {x.primaryMetricId === metric.id
                          ? "Primary"
                          : x.guardrailMetricIds.includes(metric.id)
                            ? "Guardrail"
                            : "Secondary"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="History" description="Every change to this metric's definition." />
          <AuditList
            entityType="metric"
            entityId={metric.id}
            limit={20}
            showEntity={false}
            emptyDescription="Edits to this metric will appear here with a diff of what changed."
          />
        </Panel>
      </div>
    </>
  );
}
