import { Breadcrumbs, Button, Skeleton, toast } from "@heroui/react";
import type { DataSource } from "@kuji/core/datasources/DataSource";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleCheck, CircleX, PlugZap, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AuditList } from "~/components/audit/AuditList";
import { BigQueryForm } from "~/components/datasources/BigQueryForm";
import { formatBytes } from "~/components/environments/Sparkline";
import { TrafficChart } from "~/components/overview/TrafficChart";
import { formatCount } from "~/components/results/format";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/data-sources/$dataSourceId")({
  head: () => ({ meta: [{ title: "Data source · kuji" }] }),
  component: Page,
});

const crumbs = (name: ReactNode) => (
  <Breadcrumbs className="mb-1 text-label">
    <Breadcrumbs.Item href="/data-sources">Data sources</Breadcrumbs.Item>
    <Breadcrumbs.Item>{name}</Breadcrumbs.Item>
  </Breadcrumbs>
);

function Page() {
  const { dataSourceId } = Route.useParams();
  const source = useQuery(orpc.dataSources.get.queryOptions({ input: { id: dataSourceId } }));
  if (source.isPending)
    return (
      <>
        <div className="flex flex-col gap-2 pb-6">
          <Skeleton className="h-4 w-28 rounded-md" />
          <Skeleton className="h-7 w-64 rounded-md" />
          <Skeleton className="h-5 w-96 max-w-full rounded-md" />
        </div>
        <Panel>
          <ListSkeleton />
        </Panel>
      </>
    );
  if (source.isError)
    return (
      <>
        <PageHeader breadcrumb={crumbs("Data source")} title="Data source" />
        <QueryError message={`Couldn't load this data source. ${errorMessage(source.error)}`} onRetry={() => source.refetch()} />
      </>
    );
  return source.data.type === "builtin" ? <BuiltinDetail source={source.data} /> : <WarehouseDetail source={source.data} />;
}

function MetricsUsing({ sourceId }: { sourceId: string }) {
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const using = metrics.data?.filter((m) => m.dataSourceId === sourceId) ?? [];
  return (
    <Panel>
      <PanelHeader title="Metrics" description="Metrics that read their events from this source." />
      {metrics.isPending ? (
        <ListSkeleton rows={2} />
      ) : metrics.isError ? (
        <div className="p-4">
          <QueryError message={errorMessage(metrics.error)} onRetry={() => metrics.refetch()} />
        </div>
      ) : using.length === 0 ? (
        <p className="px-5 py-6 text-body text-muted">
          No metrics use this source yet.{" "}
          <Link to="/metrics" search={{ new: true }} className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
            Create a metric
          </Link>{" "}
          and pick it as the data source.
        </p>
      ) : (
        <ul>
          {using.map((m) => (
            <li key={m.id} className={`${tbl.tr} flex h-11 items-center justify-between gap-4 px-5`}>
              <Link to="/metrics/$metricId" params={{ metricId: m.id }} className={`${tbl.rowLink} truncate`}>
                {m.name}
              </Link>
              <code className="truncate font-mono text-meta text-muted">{m.key}</code>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BuiltinDetail({ source }: { source: DataSource }) {
  const { current } = useEnvironment();
  const names = useQuery({
    ...orpc.events.names.queryOptions({ input: { environmentId: current?.id ?? "" } }),
    enabled: current !== null,
  });
  const steps: Array<[string, ReactNode]> = [
    [
      "Exposures",
      "When a user is bucketed into a running experiment, the SDK records which variation they saw. Repeats are de-duplicated per user and variation, and bot traffic is dropped.",
    ],
    [
      "Events",
      <>
        <code className="font-mono text-foreground">kuji.track(name, value?)</code> records an event. Metrics count them,
        or sum their value (e.g. revenue).
      </>,
    ],
    [
      "Storage",
      <>
        The SDK batches both to <code className="font-mono text-foreground">POST /api/sdk/v1/events/&lt;sdk key&gt;</code>{" "}
        and they're written to this deployment's D1 database, in your Cloudflare account.
      </>,
    ],
  ];
  return (
    <>
      <PageHeader
        breadcrumb={crumbs(source.name)}
        title={source.name}
        description="Always on, nothing to configure. Exposures and events sent by the SDK are stored in D1 and analyzed in the Worker."
      />
      <div className="flex flex-col gap-6">
        <Panel>
          <PanelHeader title="How data arrives" />
          <ol className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            {steps.map(([title, body], i) => (
              <li key={title} className="flex flex-col gap-1 px-5 py-4">
                <span className="text-label font-medium">
                  <span className="mr-2 font-mono text-muted tabular">{i + 1}</span>
                  {title}
                </span>
                <span className="text-label text-muted">{body}</span>
              </li>
            ))}
          </ol>
        </Panel>

        {current !== null && (
          <Panel>
            <PanelHeader title="Ingestion, last 24 hours" description={`Hourly volume in ${current.name}. Switch environments in the sidebar.`} />
            <TrafficChart environmentId={current.id} environmentName={current.name} />
          </Panel>
        )}

        <Panel>
          <PanelHeader
            title="Event names"
            description={`Distinct events received in ${current?.name ?? "this environment"} over the last 30 days, most frequent first.`}
          />
          {names.isPending ? (
            <ListSkeleton rows={4} />
          ) : names.isError ? (
            <div className="p-4">
              <QueryError message={`Couldn't load event names. ${errorMessage(names.error)}`} onRetry={() => names.refetch()} />
            </div>
          ) : names.data.length === 0 ? (
            <p className="px-5 py-6 text-body text-muted">
              No events yet. Call <code className="font-mono text-foreground">kuji.track("purchase")</code> from your app;{" "}
              <Link to="/environments" className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
                the quickstart
              </Link>{" "}
              has the setup for each runtime.
            </p>
          ) : (
            <div className="max-h-[420px] overflow-auto">
              <table className={tbl.table}>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th className={tbl.th}>Event</th>
                    <th className={`${tbl.th} text-right`}>Count</th>
                    <th className={`${tbl.th} text-right`}>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {names.data.map((n) => (
                    <tr key={n.name} className={tbl.tr}>
                      <td className={`${tbl.td} max-w-[320px] truncate font-mono`}>{n.name}</td>
                      <td className={`${tbl.td} ${tbl.num}`}>{formatCount(n.count)}</td>
                      <td className={`${tbl.td} text-right text-muted`}>
                        <RelativeTime date={n.lastSeenAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <MetricsUsing sourceId={source.id} />
      </div>
    </>
  );
}

function ConnectionTest({ source }: { source: DataSource }) {
  const test = useMutation(orpc.dataSources.test.mutationOptions());
  const r = test.data;
  return (
    <Panel>
      <PanelHeader
        title="Connection test"
        description="Authenticates with the stored key and dry-runs the exposure query. Dry runs are free and read no data."
        actions={
          <Button size="sm" variant="secondary" onPress={() => test.mutate({ id: source.id })} isPending={test.isPending} className="shrink-0">
            <PlugZap className="size-4" />
            Test connection
          </Button>
        }
      />
      <div className="px-5 py-4" aria-live="polite">
        {test.isPending ? (
          <p className="text-body text-muted">Contacting BigQuery…</p>
        ) : test.error !== null ? (
          <p role="alert" className="flex items-start gap-2 text-body text-danger">
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {errorMessage(test.error)}
          </p>
        ) : r === undefined ? (
          <p className="text-body text-muted">
            {source.hasCredentials ? "Not tested since this page opened." : "Add a service account key below, then test."}
          </p>
        ) : r.ok ? (
          <div className="flex items-start gap-2 text-body">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Connected</p>
              <p className="text-muted">
                {r.message}
                {r.bytesProcessed !== null && (
                  <>
                    {" "}
                    The exposure query would scan{" "}
                    <span className="font-mono text-foreground tabular">{formatBytes(r.bytesProcessed)}</span> per analysis.
                  </>
                )}
              </p>
            </div>
          </div>
        ) : (
          <div role="alert" className="flex items-start gap-2 text-body">
            <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-danger">Connection failed</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{r.message}</p>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function WarehouseDetail({ source }: { source: DataSource }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: true } }));
  const used = metrics.data?.filter((m) => m.dataSourceId === source.id).length ?? 0;
  const remove = useMutation(
    orpc.dataSources.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.dataSources.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(`${source.name} deleted`);
        void navigate({ to: "/data-sources" });
      },
    }),
  );
  const bq = source.bigquery;
  return (
    <>
      <PageHeader
        breadcrumb={crumbs(source.name)}
        title={source.name}
        description={
          bq === null ? (
            "BigQuery"
          ) : (
            <>
              BigQuery ·{" "}
              <span className="font-mono">
                {bq.projectId}.{bq.dataset}
              </span>{" "}
              · {bq.location}
            </>
          )
        }
        actions={
          <Button size="sm" variant="tertiary" onPress={() => setConfirming(true)}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        <ConnectionTest source={source} />
        <section className="flex flex-col gap-3">
          <h2 className="text-section font-medium">Settings</h2>
          <BigQueryForm key={source.updatedAt.toString()} source={source} onSaved={() => toast.success("Data source saved")} />
        </section>
        <MetricsUsing sourceId={source.id} />
        <Panel>
          <PanelHeader title="History" />
          <AuditList entityType="datasource" entityId={source.id} limit={20} showEntity={false} />
        </Panel>
      </div>
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) remove.reset();
        }}
        title={`Delete ${source.name}?`}
        confirmLabel="Delete data source"
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => remove.mutate({ id: source.id })}
      >
        <p>The stored service account key is erased. This can't be undone.</p>
        {used > 0 && (
          <p className="text-foreground">
            {used === 1 ? "1 metric reads" : `${used} metrics read`} from this source (archived ones included). Point{" "}
            {used === 1 ? "it" : "them"} at another source first; a source in use can't be deleted.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
