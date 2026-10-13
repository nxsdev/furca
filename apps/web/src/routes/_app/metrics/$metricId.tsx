import { Breadcrumbs, Button, buttonVariants, Skeleton, toast } from "@heroui/react";
import type { Metric } from "@furca/core/metrics/Metric";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AuditList } from "~/components/audit/AuditList";
import { StatusBadge } from "~/components/experiments/parts";
import { dataSourceName } from "~/components/datasources/name";
import { cappingLabel, Direction, formatHours, metricTypeLabel, MetricSentence, usageByMetric } from "~/components/metrics/describe";
import { MetricForm } from "~/components/metrics/MetricForm";
import { Code, ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n, intlLocale } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/metrics/$metricId")({
  validateSearch: (s: Record<string, unknown>): { edit?: true } => (s.edit ? { edit: true } : {}),
  head: () => ({ meta: [{ title: i18n.t("metrics:detailPageTitle") }] }),
  component: Page,
});

const crumbs = (name: ReactNode) => (
  <Breadcrumbs className="mb-1 text-label">
    <Breadcrumbs.Item href="/metrics">{i18n.t("metrics:list.title")}</Breadcrumbs.Item>
    <Breadcrumbs.Item>{name}</Breadcrumbs.Item>
  </Breadcrumbs>
);

function Page() {
  const { t } = useTranslation("metrics");
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
        <PageHeader breadcrumb={crumbs(t("detail.fallbackTitle"))} title={t("detail.fallbackTitle")} />
        <QueryError message={t("detail.loadFailed", { error: errorMessage(metric.error) })} onRetry={() => metric.refetch()} />
      </>
    );
  return <MetricDetail metric={metric.data} />;
}

function MetricDetail({ metric }: { metric: Metric }) {
  const { t } = useTranslation(["metrics", "common"]);
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
        toast(m.archived ? t("detail.archivedToast") : t("detail.restoredToast"), {
          description: m.archived ? t("detail.archivedToastDescription") : undefined,
        });
      },
      onError: (e) => toast.danger(t("detail.updateFailed"), { description: errorMessage(e) }),
    }),
  );

  if (edit)
    return (
      <>
        <PageHeader breadcrumb={crumbs(metric.name)} title={t("detail.editTitle", { name: metric.name })} />
        {running.length > 0 && (
          <p className="mb-4 rounded-[10px] border border-health/40 bg-health/8 px-4 py-3 text-body">
            {t("detail.runningWarning", {
              count: running.length,
              names: new Intl.ListFormat(intlLocale(), { style: "narrow", type: "conjunction" }).format(running.map((x) => x.name)),
            })}
          </p>
        )}
        <MetricForm
          metric={metric}
          onSaved={() => {
            toast.success(t("detail.savedToast"));
            void navigate({ search: {} });
          }}
          onCancel={() => void navigate({ search: {} })}
        />
      </>
    );

  const d = metric.definition;
  const facts: Array<[string, ReactNode]> = [
    [t("detail.facts.key"), <Code copy>{metric.key}</Code>],
    [t("detail.facts.type"), metricTypeLabel(metric.type)],
    [
      t("detail.facts.dataSource"),
      <Link
        to="/data-sources/$dataSourceId"
        params={{ dataSourceId: metric.dataSourceId }}
        className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        {source !== undefined ? dataSourceName(source) : metric.dataSourceId === "builtin" ? t("builtinEvents") : metric.dataSourceId}
      </Link>,
    ],
    ...(d._tag === "event"
      ? ([
          [
            metric.type === "ratio" ? t("detail.facts.numerator") : t("detail.facts.event"),
            <span className="font-mono">
              {d.numerator.event}
              {metric.type !== "proportion" && <span className="text-muted"> · {t(`detail.aggregation.${d.numerator.aggregation}`)}</span>}
            </span>,
          ],
          ...(d.denominator !== null
            ? ([
                [
                  t("detail.facts.denominator"),
                  <span className="font-mono">
                    {d.denominator.event}
                    <span className="text-muted"> · {t(`detail.aggregation.${d.denominator.aggregation}`)}</span>
                  </span>,
                ],
              ] as Array<[string, ReactNode]>)
            : []),
        ] as Array<[string, ReactNode]>)
      : []),
    [t("detail.facts.window"), metric.windowHours === null ? t("detail.facts.windowNone") : formatHours(metric.windowHours)],
    [t("detail.facts.delay"), metric.delayHours > 0 ? formatHours(metric.delayHours) : t("common:states.none")],
    ...(metric.type !== "proportion"
      ? ([[t("detail.facts.capping"), cappingLabel(metric.capping)]] as Array<[string, ReactNode]>)
      : []),
    [t("detail.facts.goal"), <Direction inverse={metric.inverse} />],
    [t("detail.facts.updated"), <RelativeTime date={metric.updatedAt} />],
  ];

  return (
    <>
      <PageHeader
        breadcrumb={crumbs(metric.name)}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {metric.name}
            {metric.archived && (
              <span className="rounded-md border border-border px-2 py-0.5 text-label font-medium text-muted">{t("archived")}</span>
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
              {metric.archived ? t("common:actions.restore") : t("common:actions.archive")}
            </Button>
            <Link to="." search={{ edit: true }} className={buttonVariants({ size: "sm", variant: "secondary" })}>
              <Pencil className="size-4" />
              {t("common:actions.edit")}
            </Link>
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Panel>
          <div className="border-b border-border px-5 py-5">
            <h2 className="text-meta font-medium text-muted">{t("detail.definition")}</h2>
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
                [metric.type === "ratio" ? t("detail.sql.numerator") : t("detail.sql.single"), d.numeratorSql] as const,
                ...(d.denominatorSql !== null ? ([[t("detail.sql.denominator"), d.denominatorSql]] as const) : []),
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
          <PanelHeader title={t("detail.usedBy.title")} description={t("detail.usedBy.description")} />
          {experiments.isPending ? (
            <ListSkeleton rows={2} />
          ) : experiments.isError ? (
            <div className="p-4">
              <QueryError
                message={t("detail.usedBy.loadFailed", { error: errorMessage(experiments.error) })}
                onRetry={() => experiments.refetch()}
              />
            </div>
          ) : usedBy.length === 0 ? (
            <p className="px-5 py-6 text-body text-muted">
              <Trans
                t={t}
                i18nKey="detail.usedBy.empty"
                components={{
                  link: (
                    <Link
                      to="/experiments/new"
                      className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                    />
                  ),
                }}
              />
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>{t("detail.usedBy.columns.experiment")}</th>
                    <th className={tbl.th}>{t("detail.usedBy.columns.status")}</th>
                    <th className={`${tbl.th} text-right`}>{t("detail.usedBy.columns.role")}</th>
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
                          ? t("detail.usedBy.roles.primary")
                          : x.guardrailMetricIds.includes(metric.id)
                            ? t("detail.usedBy.roles.guardrail")
                            : t("detail.usedBy.roles.secondary")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title={t("detail.history.title")} description={t("detail.history.description")} />
          <AuditList
            entityType="metric"
            entityId={metric.id}
            limit={20}
            showEntity={false}
            emptyDescription={t("detail.history.empty")}
          />
        </Panel>
      </div>
    </>
  );
}
