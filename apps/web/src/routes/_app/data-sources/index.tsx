import { Breadcrumbs, buttonVariants, toast } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Database, Plus } from "lucide-react";
import { BigQueryForm } from "~/components/datasources/BigQueryForm";
import { ListSkeleton, PageHeader, Panel, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/data-sources/")({
  validateSearch: (s: Record<string, unknown>): { new?: true } => (s.new ? { new: true } : {}),
  head: () => ({ meta: [{ title: "Data sources · furca" }] }),
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
              <Breadcrumbs.Item href="/data-sources">Data sources</Breadcrumbs.Item>
              <Breadcrumbs.Item>New BigQuery source</Breadcrumbs.Item>
            </Breadcrumbs>
          }
          title="Connect BigQuery"
          description="Analyze experiments with exposures and events already in your warehouse, like a GA4 or Segment export."
        />
        <div className="max-w-[860px]">
          <BigQueryForm
            onSaved={(s) => {
              toast.success(`${s.name} created`, { description: "Test the connection to check access and the exposure query." });
              void navigate({ to: "/data-sources/$dataSourceId", params: { dataSourceId: s.id } });
            }}
            onCancel={() => void navigate({ search: {} })}
          />
        </div>
      </>
    );
  return <SourceList />;
}

function SourceList() {
  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const metricCount = (id: string) => metrics.data?.filter((m) => m.dataSourceId === id).length ?? 0;
  // Built-in first, then warehouses by name
  const rows = [...(sources.data ?? [])].sort(
    (a, b) => Number(b.type === "builtin") - Number(a.type === "builtin") || a.name.localeCompare(b.name),
  );
  const hasWarehouse = rows.some((s) => s.type === "bigquery");

  return (
    <>
      <PageHeader
        title="Data sources"
        description="Where exposures and metric events are read from. The built-in store works out of the box; add BigQuery to use your warehouse."
        actions={
          <Link to="/data-sources" search={{ new: true }} className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" />
            Connect BigQuery
          </Link>
        }
      />
      {sources.isPending ? (
        <Panel>
          <ListSkeleton rows={2} />
        </Panel>
      ) : sources.isError ? (
        <QueryError message={`Couldn't load data sources. ${errorMessage(sources.error)}`} onRetry={() => sources.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Panel>
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>Name</th>
                    <th className={tbl.th}>Type</th>
                    <th className={`${tbl.th} hidden md:table-cell`}>Location</th>
                    <th className={`${tbl.th} hidden text-right sm:table-cell`}>Metrics</th>
                    <th className={`${tbl.th} hidden text-right lg:table-cell`}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const n = metricCount(s.id);
                    return (
                      <tr key={s.id} className={tbl.tr}>
                        <td className={`${tbl.td} max-w-[280px]`}>
                          <span className="flex items-center gap-2.5">
                            <Database className="size-4 shrink-0 text-muted" aria-hidden="true" />
                            <Link
                              to="/data-sources/$dataSourceId"
                              params={{ dataSourceId: s.id }}
                              className={`${tbl.rowLink} truncate`}
                            >
                              {s.name}
                            </Link>
                          </span>
                        </td>
                        <td className={`${tbl.td} whitespace-nowrap`}>{s.type === "builtin" ? "Built-in (D1)" : "BigQuery"}</td>
                        <td className={`${tbl.td} hidden max-w-[300px] truncate md:table-cell`}>
                          {s.bigquery === null ? (
                            <span className="text-muted">This deployment's D1</span>
                          ) : (
                            <span className="font-mono">
                              {s.bigquery.projectId}.{s.bigquery.dataset}
                              <span className="text-muted"> · {s.bigquery.location}</span>
                            </span>
                          )}
                        </td>
                        <td className={`${tbl.td} hidden text-right tabular sm:table-cell ${n === 0 ? "text-muted" : ""}`}>
                          {metrics.isError ? "—" : n}
                        </td>
                        <td className={`${tbl.td} hidden text-right text-muted lg:table-cell`}>
                          <RelativeTime date={s.updatedAt} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
          {!hasWarehouse && (
            <p className="max-w-[72ch] text-label text-muted">
              Already send events to GA4 or Segment with a BigQuery export? Connect it and furca reads exposures and metrics
              straight from your tables with SQL you control. Templates for both are included.
            </p>
          )}
        </div>
      )}
    </>
  );
}
