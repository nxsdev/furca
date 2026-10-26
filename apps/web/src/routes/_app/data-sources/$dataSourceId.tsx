import { Breadcrumbs, Button, Skeleton, toast } from "@heroui/react";
import { type DataSource, WAREHOUSE_LABELS, type WarehouseType } from "@furca/core/datasources/DataSource";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleCheck, CircleX, PlugZap, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AuditList } from "~/components/audit/AuditList";
import { DataSourceForm } from "~/components/datasources/DataSourceForm";
import { configSummary, dataSourceName } from "~/components/datasources/name";
import { formatBytes } from "~/components/environments/Sparkline";
import { TrafficChart } from "~/components/overview/TrafficChart";
import { formatCount } from "~/components/results/format";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { usePermissions } from "~/lib/permissions";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/data-sources/$dataSourceId")({
  head: () => ({ meta: [{ title: i18n.t(($) => $.detailPageTitle, { ns: "datasources" }) }] }),
  component: Page,
});

const crumbs = (name: ReactNode) => (
  <Breadcrumbs className="mb-1 text-label">
    <Breadcrumbs.Item href="/data-sources">{i18n.t(($) => $.list.title, { ns: "datasources" })}</Breadcrumbs.Item>
    <Breadcrumbs.Item>{name}</Breadcrumbs.Item>
  </Breadcrumbs>
);

const code = <code className="font-mono text-foreground" />;

function Page() {
  const { t } = useTranslation("datasources");
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
        <PageHeader breadcrumb={crumbs(t(($) => $.detail.fallbackTitle))} title={t(($) => $.detail.fallbackTitle)} />
        <QueryError message={t(($) => $.detail.loadFailed, { error: errorMessage(source.error) })} onRetry={() => source.refetch()} />
      </>
    );
  return source.data.type === "builtin" ? (
    <BuiltinDetail source={source.data} />
  ) : (
    <WarehouseDetail source={source.data} type={source.data.type} />
  );
}

function MetricsUsing({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation("datasources");
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const using = metrics.data?.filter((m) => m.dataSourceId === sourceId) ?? [];
  return (
    <Panel>
      <PanelHeader title={t(($) => $.detail.metrics.title)} description={t(($) => $.detail.metrics.description)} />
      {metrics.isPending ? (
        <ListSkeleton rows={2} />
      ) : metrics.isError ? (
        <div className="p-4">
          <QueryError message={errorMessage(metrics.error)} onRetry={() => metrics.refetch()} />
        </div>
      ) : using.length === 0 ? (
        <p className="px-5 py-6 text-body text-muted">
          <Trans
            t={t}
            i18nKey={($) => $.detail.metrics.empty}
            components={{
              link: (
                <Link
                  to="/metrics"
                  search={{ new: true }}
                  className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                />
              ),
            }}
          />
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
  const { t } = useTranslation("datasources");
  const { current } = useEnvironment();
  const names = useQuery({
    ...orpc.events.names.queryOptions({ input: { environmentId: current?.id ?? "" } }),
    enabled: current !== null,
  });
  const steps: Array<[string, ReactNode]> = [
    [t(($) => $.detail.builtin.steps.exposuresTitle), t(($) => $.detail.builtin.steps.exposures)],
    [t(($) => $.detail.builtin.steps.eventsTitle), <Trans t={t} i18nKey={($) => $.detail.builtin.steps.events} components={{ c: code }} />],
    [
      t(($) => $.detail.builtin.steps.storageTitle),
      <Trans
        t={t}
        i18nKey={($) => $.detail.builtin.steps.storage}
        components={{ endpoint: <code className="font-mono text-foreground">POST /api/sdk/v1/events/&lt;sdk key&gt;</code> }}
      />,
    ],
  ];
  return (
    <>
      <PageHeader
        breadcrumb={crumbs(dataSourceName(source))}
        title={dataSourceName(source)}
        description={t(($) => $.detail.builtin.description)}
      />
      <div className="flex flex-col gap-6">
        <Panel>
          <PanelHeader title={t(($) => $.detail.builtin.howTitle)} />
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
            <PanelHeader
              title={t(($) => $.detail.builtin.ingestionTitle)}
              description={t(($) => $.detail.builtin.ingestionDescription, { environment: current.name })}
            />
            <TrafficChart environmentId={current.id} environmentName={current.name} />
          </Panel>
        )}

        <Panel>
          <PanelHeader
            title={t(($) => $.detail.builtin.eventNamesTitle)}
            description={t(($) => $.detail.builtin.eventNamesDescription, { environment: current?.name ?? t(($) => $.thisEnvironment) })}
          />
          {names.isPending ? (
            <ListSkeleton rows={4} />
          ) : names.isError ? (
            <div className="p-4">
              <QueryError
                message={t(($) => $.detail.builtin.eventNamesLoadFailed, { error: errorMessage(names.error) })}
                onRetry={() => names.refetch()}
              />
            </div>
          ) : names.data.length === 0 ? (
            <p className="px-5 py-6 text-body text-muted">
              <Trans
                t={t}
                i18nKey={($) => $.detail.builtin.eventNamesEmpty}
                components={{
                  c: code,
                  link: (
                    <Link
                      to="/environments"
                      className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                    />
                  ),
                }}
              />
            </p>
          ) : (
            <div className="max-h-[420px] overflow-auto">
              <table className={tbl.table}>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th className={tbl.th}>{t(($) => $.detail.builtin.columns.event)}</th>
                    <th className={`${tbl.th} text-right`}>{t(($) => $.detail.builtin.columns.count)}</th>
                    <th className={`${tbl.th} text-right`}>{t(($) => $.detail.builtin.columns.lastSeen)}</th>
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

function ConnectionTest({ source, type }: { source: DataSource; type: WarehouseType }) {
  const { t } = useTranslation("datasources");
  const test = useMutation(orpc.dataSources.test.mutationOptions());
  const r = test.data;
  return (
    <Panel>
      <PanelHeader
        title={t(($) => $.detail.test.title)}
        description={type === "bigquery" ? t(($) => $.detail.test.description) : t(($) => $.detail.test.descriptionLimit0)}
        actions={
          <Button size="sm" variant="secondary" onPress={() => test.mutate({ id: source.id })} isPending={test.isPending} className="shrink-0">
            <PlugZap className="size-4" />
            {t(($) => $.detail.test.button)}
          </Button>
        }
      />
      <div className="px-5 py-4" aria-live="polite">
        {test.isPending ? (
          <p className="text-body text-muted">{t(($) => $.detail.test.pending, { warehouse: WAREHOUSE_LABELS[type] })}</p>
        ) : test.error !== null ? (
          <p role="alert" className="flex items-start gap-2 text-body text-danger">
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {errorMessage(test.error)}
          </p>
        ) : r === undefined ? (
          <p className="text-body text-muted">
            {source.hasCredentials ? t(($) => $.detail.test.notTested) : t(($) => $.detail.test.noSecret[type])}
          </p>
        ) : r.ok ? (
          <div className="flex items-start gap-2 text-body">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">{t(($) => $.detail.test.connected)}</p>
              <p className="text-muted">
                {r.message}
                {r.bytesProcessed !== null && (
                  <>
                    {" "}
                    <Trans
                      t={t}
                      i18nKey={($) => $.detail.test.scan}
                      values={{ bytes: formatBytes(r.bytesProcessed) }}
                      components={{ bytes: <span className="font-mono text-foreground tabular" /> }}
                    />
                  </>
                )}
              </p>
            </div>
          </div>
        ) : (
          <div role="alert" className="flex items-start gap-2 text-body">
            <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-danger">{t(($) => $.detail.test.failed)}</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-muted">{r.message}</p>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function WarehouseDetail({ source, type }: { source: DataSource; type: WarehouseType }) {
  const { t } = useTranslation(["datasources", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { isAdmin } = usePermissions();
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: true } }));
  const used = metrics.data?.filter((m) => m.dataSourceId === source.id).length ?? 0;
  const remove = useMutation(
    orpc.dataSources.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.dataSources.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(t(($) => $.detail.deletedToast, { name: source.name }));
        void navigate({ to: "/data-sources" });
      },
    }),
  );
  return (
    <>
      <PageHeader
        breadcrumb={crumbs(source.name)}
        title={source.name}
        description={
          source.config === null ? (
            WAREHOUSE_LABELS[type]
          ) : (
            <>
              {WAREHOUSE_LABELS[type]} · <span className="font-mono">{configSummary(source.config)}</span>
            </>
          )
        }
        actions={
          isAdmin && (
            <Button size="sm" variant="tertiary" onPress={() => setConfirming(true)}>
              <Trash2 className="size-4" />
              {t(($) => $.actions.delete, { ns: "common" })}
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-6">
        {/* Testing and editing need admin (the test runs SQL with the stored credentials) */}
        {isAdmin && (
          <>
            <ConnectionTest source={source} type={type} />
            <section className="flex flex-col gap-3">
              <h2 className="text-section font-medium">{t(($) => $.detail.settings)}</h2>
              <DataSourceForm key={source.updatedAt.toString()} type={type} source={source} onSaved={() => toast.success(t(($) => $.detail.savedToast))} />
            </section>
          </>
        )}
        <MetricsUsing sourceId={source.id} />
        <Panel>
          <PanelHeader title={t(($) => $.detail.history)} />
          <AuditList entityType="datasource" entityId={source.id} limit={20} showEntity={false} />
        </Panel>
      </div>
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) remove.reset();
        }}
        title={t(($) => $.detail.delete.title, { name: source.name })}
        confirmLabel={t(($) => $.detail.delete.confirm)}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => remove.mutate({ id: source.id })}
      >
        <p>{t(($) => $.detail.delete.body)}</p>
        {used > 0 && <p className="text-foreground">{t(($) => $.detail.delete.inUse, { count: used })}</p>}
      </ConfirmDialog>
    </>
  );
}
