import { Breadcrumbs, buttonVariants, Switch } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChartLine, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { dataSourceName } from "~/components/datasources/name";
import { Direction, metricTypeLabel, usageByMetric, windowLabel } from "~/components/metrics/describe";
import { MetricForm } from "~/components/metrics/MetricForm";
import { EmptyState, ListSkeleton, PageHeader, Panel, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { usePermissions } from "~/lib/permissions";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/metrics/")({
  validateSearch: (s: Record<string, unknown>): { new?: true } => (s.new ? { new: true } : {}),
  head: () => ({ meta: [{ title: i18n.t("metrics:pageTitle") }] }),
  component: Page,
});

function Page() {
  const { t } = useTranslation("metrics");
  const { new: isNew } = Route.useSearch();
  const { canEdit } = usePermissions();
  const navigate = Route.useNavigate();
  if (isNew && canEdit)
    return (
      <>
        <PageHeader
          breadcrumb={
            <Breadcrumbs className="mb-1 text-label">
              <Breadcrumbs.Item href="/metrics">{t("list.title")}</Breadcrumbs.Item>
              <Breadcrumbs.Item>{t("new.breadcrumb")}</Breadcrumbs.Item>
            </Breadcrumbs>
          }
          title={t("new.title")}
          description={t("new.description")}
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
  const { t } = useTranslation(["metrics", "common"]);
  const [showArchived, setShowArchived] = useState(false);
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: showArchived } }));
  const sources = useQuery(orpc.dataSources.list.queryOptions());
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const usage = usageByMetric(experiments.data ?? []);
  const sourceName = (id: string) => {
    const s = sources.data?.find((x) => x.id === id);
    return s !== undefined ? dataSourceName(s) : id === "builtin" ? t("builtinEvents") : "—";
  };

  const { canEdit } = usePermissions();
  const newButton = canEdit && (
    <Link to="/metrics" search={{ new: true }} className={buttonVariants({ size: "sm" })}>
      <Plus className="size-4" />
      {t("list.newMetric")}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={t("list.title")}
        description={t("list.description")}
        actions={newButton}
      />
      {metrics.isPending ? (
        <Panel>
          <ListSkeleton />
        </Panel>
      ) : metrics.isError ? (
        <QueryError message={t("list.loadFailed", { error: errorMessage(metrics.error) })} onRetry={() => metrics.refetch()} />
      ) : metrics.data.length === 0 && !showArchived ? (
        <EmptyState
          icon={<ChartLine />}
          title={t("list.emptyTitle")}
          description={t("list.emptyDescription")}
          action={newButton}
        />
      ) : (
        <Panel>
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
            <p className="text-label text-muted tabular">
              {t("list.count", { count: metrics.data.length })}
            </p>
            <Switch size="sm" isSelected={showArchived} onChange={setShowArchived} className="[--switch-control-bg:oklch(0.9_0_0)] dark:[--switch-control-bg:var(--default)]">
              <Switch.Content className="text-label text-muted">
                <Switch.Control>
                  <Switch.Thumb className={showArchived ? "" : "dark:bg-[oklch(0.62_0_0)]"} />
                </Switch.Control>
                {t("list.showArchived")}
              </Switch.Content>
            </Switch>
          </div>
          <div className="overflow-x-auto">
            <table className={tbl.table}>
              <thead>
                <tr>
                  <th className={tbl.th}>{t("list.columns.metric")}</th>
                  <th className={tbl.th}>{t("list.columns.type")}</th>
                  <th className={`${tbl.th} hidden md:table-cell`}>{t("list.columns.dataSource")}</th>
                  <th className={`${tbl.th} hidden sm:table-cell`}>{t("list.columns.goal")}</th>
                  <th className={`${tbl.th} hidden lg:table-cell`}>{t("list.columns.window")}</th>
                  <th className={`${tbl.th} text-right`}>{t("list.columns.usedBy")}</th>
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
                          {m.archived && <span className="text-meta text-muted">· {t("archived")}</span>}
                        </span>
                      </td>
                      <td className={tbl.td}>{metricTypeLabel(m.type)}</td>
                      <td className={`${tbl.td} hidden max-w-[200px] truncate md:table-cell`}>{sourceName(m.dataSourceId)}</td>
                      <td className={`${tbl.td} hidden sm:table-cell`}>
                        <Direction inverse={m.inverse} />
                      </td>
                      <td
                        className={`${tbl.td} hidden whitespace-nowrap lg:table-cell ${m.windowHours === null ? "text-muted" : "font-mono tabular"}`}
                      >
                        {m.windowHours === null && m.delayHours === 0 ? t("common:states.none") : windowLabel(m)}
                      </td>
                      <td className={`${tbl.td} whitespace-nowrap text-right tabular ${used === 0 ? "text-muted" : ""}`}>
                        {experiments.isError ? (
                          "—"
                        ) : (
                          <>
                            <span className="font-mono sm:hidden">{used}</span>
                            <span className="hidden sm:inline">
                              {used === 0 ? t("common:states.none") : t("list.experimentCount", { count: used })}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {metrics.data.length === 0 && <p className="px-5 py-10 text-center text-body text-muted">{t("list.noArchived")}</p>}
          </div>
        </Panel>
      )}
    </>
  );
}
