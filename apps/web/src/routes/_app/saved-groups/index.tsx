import { Breadcrumbs, buttonVariants } from "@heroui/react";
import type { SavedGroup } from "@furca/core/targeting/SavedGroup";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatCount } from "~/components/results/format";
import { SavedGroupForm } from "~/components/savedGroups/SavedGroupForm";
import { groupUsage } from "~/components/savedGroups/usage";
import { useConditionsSummary } from "~/components/targeting/ConditionBuilder";
import { EmptyState, ListSkeleton, PageHeader, Panel, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/saved-groups/")({
  validateSearch: (s: Record<string, unknown>): { new?: true } => (s.new ? { new: true } : {}),
  head: () => ({ meta: [{ title: i18n.t("savedGroups:pageTitle") }] }),
  component: Page,
});

function Page() {
  const { t } = useTranslation("savedGroups");
  const { new: isNew } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (isNew)
    return (
      <>
        <PageHeader
          breadcrumb={
            <Breadcrumbs className="mb-1 text-label">
              <Breadcrumbs.Item href="/saved-groups">{t("list.title")}</Breadcrumbs.Item>
              <Breadcrumbs.Item>{t("new.breadcrumb")}</Breadcrumbs.Item>
            </Breadcrumbs>
          }
          title={t("new.title")}
          description={t("new.description")}
        />
        <div className="max-w-3xl">
          <SavedGroupForm
            onSaved={(g) => void navigate({ to: "/saved-groups/$savedGroupId", params: { savedGroupId: g.id } })}
            onCancel={() => void navigate({ search: {} })}
          />
        </div>
      </>
    );
  return <GroupList />;
}

function GroupList() {
  const { t } = useTranslation(["savedGroups", "common"]);
  const groups = useQuery(orpc.savedGroups.list.queryOptions());
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const usage = groupUsage(features.data ?? [], experiments.data ?? []);
  const usageKnown = features.isSuccess && experiments.isSuccess;
  const summary = useConditionsSummary();
  /** "id · 1,234 values" for lists, the condition sentence otherwise */
  const members = (g: SavedGroup) =>
    g.type === "list" ? (
      <span className="tabular">
        <code className="font-mono">{g.attribute}</code> · {t("list.valueCount", { count: g.values.length, formatted: formatCount(g.values.length) })}
      </span>
    ) : (
      summary(g.conditions)
    );

  const newButton = (
    <Link to="/saved-groups" search={{ new: true }} className={buttonVariants({ size: "sm" })}>
      <Plus className="size-4" />
      {t("list.new")}
    </Link>
  );

  return (
    <>
      <PageHeader title={t("list.title")} description={t("list.description")} actions={newButton} />
      {groups.isPending ? (
        <Panel>
          <ListSkeleton />
        </Panel>
      ) : groups.isError ? (
        <QueryError message={t("list.loadFailed", { message: errorMessage(groups.error) })} onRetry={() => groups.refetch()} />
      ) : groups.data.length === 0 ? (
        <EmptyState icon={<UsersRound />} title={t("list.emptyTitle")} description={t("list.emptyDescription")} action={newButton} />
      ) : (
        <Panel>
          <div className="overflow-x-auto">
            <table className={tbl.table}>
              <thead>
                <tr>
                  <th className={tbl.th}>{t("list.columns.group")}</th>
                  <th className={`${tbl.th} hidden sm:table-cell`}>{t("list.columns.type")}</th>
                  <th className={`${tbl.th} hidden md:table-cell`}>{t("list.columns.members")}</th>
                  <th className={`${tbl.th} text-right`}>{t("list.columns.usedBy")}</th>
                  <th className={`${tbl.th} hidden text-right lg:table-cell`}>{t("list.columns.updated")}</th>
                </tr>
              </thead>
              <tbody>
                {groups.data.map((g) => {
                  const used = usage.get(g.id);
                  const parts = [
                    used !== undefined && used.flags.length > 0 ? t("list.flagCount", { count: used.flags.length }) : null,
                    used !== undefined && used.experiments.length > 0 ? t("list.experimentCount", { count: used.experiments.length }) : null,
                  ].filter((p) => p !== null);
                  return (
                    <tr key={g.id} className={tbl.tr}>
                      <td className={`${tbl.td} max-w-[280px] py-2`}>
                        <Link to="/saved-groups/$savedGroupId" params={{ savedGroupId: g.id }} className={`${tbl.rowLink} block truncate`}>
                          {g.name}
                        </Link>
                        <code className="block truncate font-mono text-meta text-muted">{g.key}</code>
                      </td>
                      <td className={`${tbl.td} hidden whitespace-nowrap sm:table-cell`}>{t(`type.${g.type}`)}</td>
                      <td className={`${tbl.td} hidden max-w-[360px] truncate md:table-cell`}>
                        {members(g)}
                      </td>
                      <td className={`${tbl.td} whitespace-nowrap text-right tabular ${parts.length === 0 ? "text-muted" : ""}`}>
                        {!usageKnown ? "—" : parts.length === 0 ? t("common:states.none") : parts.join(" · ")}
                      </td>
                      <td className={`${tbl.td} hidden text-right text-muted lg:table-cell`}>
                        <RelativeTime date={g.updatedAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
