import { Breadcrumbs, buttonVariants, toast } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Database, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WAREHOUSE_LABELS, WarehouseType } from "@furca/core/datasources/DataSource";
import { DataSourceForm } from "~/components/datasources/DataSourceForm";
import { configSummary, dataSourceName, dataSourceTypeLabel } from "~/components/datasources/name";
import { ListSkeleton, PageHeader, Panel, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n, intlLocale } from "~/i18n";
import { usePermissions } from "~/lib/permissions";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/data-sources/")({
  validateSearch: (s: Record<string, unknown>): { new?: true; type?: WarehouseType } => ({
    ...(s.new ? { new: true } : {}),
    ...((WarehouseType.literals as ReadonlyArray<unknown>).includes(s.type) ? { type: s.type as WarehouseType } : {}),
  }),
  head: () => ({ meta: [{ title: i18n.t(($) => $.pageTitle, { ns: "datasources" }) }] }),
  component: Page,
});

function Page() {
  const { t } = useTranslation("datasources");
  const { new: isNew, type } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { isAdmin } = usePermissions();
  // Connecting a warehouse is admin-only on the server too
  if (!isNew || !isAdmin) return <SourceList />;
  const crumbs = (
    <Breadcrumbs className="mb-1 text-label">
      <Breadcrumbs.Item href="/data-sources">{t(($) => $.list.title)}</Breadcrumbs.Item>
      <Breadcrumbs.Item>{type === undefined ? t(($) => $.new.breadcrumb) : WAREHOUSE_LABELS[type]}</Breadcrumbs.Item>
    </Breadcrumbs>
  );
  if (type === undefined)
    return (
      <>
        <PageHeader breadcrumb={crumbs} title={t(($) => $.new.title)} description={t(($) => $.new.description)} />
        <ul className="grid max-w-[860px] gap-3 sm:grid-cols-2" aria-label={t(($) => $.new.title)}>
          {WarehouseType.literals.map((w) => (
            <li key={w}>
              <Link
                to="/data-sources"
                search={{ new: true, type: w }}
                className="flex h-full flex-col gap-1 rounded-[10px] border border-border bg-surface px-4 py-3 outline-none transition-colors duration-150 hover:bg-default/40 focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="flex items-center gap-2 text-body font-medium">
                  <Database className="size-4 text-muted" aria-hidden="true" />
                  {WAREHOUSE_LABELS[w]}
                </span>
                <span className="text-label text-muted">{t(($) => $.types[w])}</span>
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <>
      <PageHeader
        breadcrumb={crumbs}
        title={t(($) => $.new.connect, { warehouse: WAREHOUSE_LABELS[type] })}
        description={t(($) => $.types[type])}
      />
      <div className="max-w-[860px]">
        <DataSourceForm
          key={type}
          type={type}
          onSaved={(s) => {
            toast.success(t(($) => $.new.createdToast, { name: s.name }), { description: t(($) => $.new.createdToastDescription) });
            void navigate({ to: "/data-sources/$dataSourceId", params: { dataSourceId: s.id } });
          }}
          onCancel={() => void navigate({ search: { new: true } })}
        />
      </div>
    </>
  );
}

function SourceList() {
  const { t } = useTranslation("datasources");
  const { isAdmin } = usePermissions();
  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const metricCount = (id: string) => metrics.data?.filter((m) => m.dataSourceId === id).length ?? 0;
  // Built-in first, then warehouses by name
  const rows = [...(sources.data ?? [])].sort(
    (a, b) => Number(b.type === "builtin") - Number(a.type === "builtin") || dataSourceName(a).localeCompare(dataSourceName(b), intlLocale()),
  );
  const hasWarehouse = rows.some((s) => s.type !== "builtin");

  return (
    <>
      <PageHeader
        title={t(($) => $.list.title)}
        description={t(($) => $.list.description)}
        actions={
          isAdmin && (
            <Link to="/data-sources" search={{ new: true }} className={buttonVariants({ size: "sm" })}>
              <Plus className="size-4" />
              {t(($) => $.list.connect)}
            </Link>
          )
        }
      />
      {sources.isPending ? (
        <Panel>
          <ListSkeleton rows={2} />
        </Panel>
      ) : sources.isError ? (
        <QueryError message={t(($) => $.list.loadFailed, { error: errorMessage(sources.error) })} onRetry={() => sources.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <Panel>
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>{t(($) => $.list.columns.name)}</th>
                    <th className={tbl.th}>{t(($) => $.list.columns.type)}</th>
                    <th className={`${tbl.th} hidden md:table-cell`}>{t(($) => $.list.columns.location)}</th>
                    <th className={`${tbl.th} hidden text-right sm:table-cell`}>{t(($) => $.list.columns.metrics)}</th>
                    <th className={`${tbl.th} hidden text-right lg:table-cell`}>{t(($) => $.list.columns.updated)}</th>
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
                        <td className={`${tbl.td} whitespace-nowrap`}>{dataSourceTypeLabel(s)}</td>
                        <td className={`${tbl.td} hidden max-w-[300px] truncate md:table-cell`}>
                          {s.config === null ? (
                            <span className="text-muted">{t(($) => $.list.builtinLocation)}</span>
                          ) : (
                            <span className="font-mono">{configSummary(s.config)}</span>
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
              {t(($) => $.list.warehouseHint)}
            </p>
          )}
        </div>
      )}
    </>
  );
}
