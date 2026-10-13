import { Breadcrumbs, buttonVariants, toast } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Database, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BigQueryForm } from "~/components/datasources/BigQueryForm";
import { dataSourceName } from "~/components/datasources/name";
import { ListSkeleton, PageHeader, Panel, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n, intlLocale } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/data-sources/")({
  validateSearch: (s: Record<string, unknown>): { new?: true } => (s.new ? { new: true } : {}),
  head: () => ({ meta: [{ title: i18n.t("datasources:pageTitle") }] }),
  component: Page,
});

function Page() {
  const { t } = useTranslation("datasources");
  const { new: isNew } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (isNew)
    return (
      <>
        <PageHeader
          breadcrumb={
            <Breadcrumbs className="mb-1 text-label">
              <Breadcrumbs.Item href="/data-sources">{t("list.title")}</Breadcrumbs.Item>
              <Breadcrumbs.Item>{t("new.breadcrumb")}</Breadcrumbs.Item>
            </Breadcrumbs>
          }
          title={t("new.title")}
          description={t("new.description")}
        />
        <div className="max-w-[860px]">
          <BigQueryForm
            onSaved={(s) => {
              toast.success(t("new.createdToast", { name: s.name }), { description: t("new.createdToastDescription") });
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
  const { t } = useTranslation("datasources");
  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const metricCount = (id: string) => metrics.data?.filter((m) => m.dataSourceId === id).length ?? 0;
  // Built-in first, then warehouses by name
  const rows = [...(sources.data ?? [])].sort(
    (a, b) => Number(b.type === "builtin") - Number(a.type === "builtin") || dataSourceName(a).localeCompare(dataSourceName(b), intlLocale()),
  );
  const hasWarehouse = rows.some((s) => s.type === "bigquery");

  return (
    <>
      <PageHeader
        title={t("list.title")}
        description={t("list.description")}
        actions={
          <Link to="/data-sources" search={{ new: true }} className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" />
            {t("list.connect")}
          </Link>
        }
      />
      {sources.isPending ? (
        <Panel>
          <ListSkeleton rows={2} />
        </Panel>
      ) : sources.isError ? (
        <QueryError message={t("list.loadFailed", { error: errorMessage(sources.error) })} onRetry={() => sources.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Panel>
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>{t("list.columns.name")}</th>
                    <th className={tbl.th}>{t("list.columns.type")}</th>
                    <th className={`${tbl.th} hidden md:table-cell`}>{t("list.columns.location")}</th>
                    <th className={`${tbl.th} hidden text-right sm:table-cell`}>{t("list.columns.metrics")}</th>
                    <th className={`${tbl.th} hidden text-right lg:table-cell`}>{t("list.columns.updated")}</th>
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
                              {dataSourceName(s)}
                            </Link>
                          </span>
                        </td>
                        <td className={`${tbl.td} whitespace-nowrap`}>{s.type === "builtin" ? t("list.builtinType") : "BigQuery"}</td>
                        <td className={`${tbl.td} hidden max-w-[300px] truncate md:table-cell`}>
                          {s.bigquery === null ? (
                            <span className="text-muted">{t("list.builtinLocation")}</span>
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
              {t("list.warehouseHint")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
