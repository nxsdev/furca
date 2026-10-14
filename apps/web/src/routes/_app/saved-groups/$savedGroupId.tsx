import { Breadcrumbs, Button, Skeleton, toast } from "@heroui/react";
import type { SavedGroup } from "@furca/core/targeting/SavedGroup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuditList } from "~/components/audit/AuditList";
import { StatusBadge } from "~/components/experiments/parts";
import { SavedGroupForm } from "~/components/savedGroups/SavedGroupForm";
import { groupUsage } from "~/components/savedGroups/usage";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { ListSkeleton, PageHeader, Panel, PanelHeader, QueryError } from "~/components/ui/primitives";
import { i18n } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/saved-groups/$savedGroupId")({
  head: () => ({ meta: [{ title: i18n.t("savedGroups:detailPageTitle") }] }),
  component: Page,
});

const crumbs = (name: ReactNode) => (
  <Breadcrumbs className="mb-1 text-label">
    <Breadcrumbs.Item href="/saved-groups">{i18n.t("savedGroups:list.title")}</Breadcrumbs.Item>
    <Breadcrumbs.Item>{name}</Breadcrumbs.Item>
  </Breadcrumbs>
);

function Page() {
  const { t } = useTranslation("savedGroups");
  const { savedGroupId } = Route.useParams();
  const group = useQuery(orpc.savedGroups.get.queryOptions({ input: { id: savedGroupId } }));
  if (group.isPending)
    return (
      <>
        <div className="flex flex-col gap-2 pb-6">
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-7 w-64 rounded-md" />
        </div>
        <Panel>
          <ListSkeleton rows={6} />
        </Panel>
      </>
    );
  if (group.isError)
    return (
      <>
        <PageHeader breadcrumb={crumbs(t("detail.fallbackTitle"))} title={t("detail.fallbackTitle")} />
        <QueryError message={t("detail.loadFailed", { message: errorMessage(group.error) })} onRetry={() => group.refetch()} />
      </>
    );
  return <Detail group={group.data} />;
}

function Detail({ group }: { group: SavedGroup }) {
  const { t } = useTranslation(["savedGroups", "common"]);
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const used = groupUsage(features.data ?? [], experiments.data ?? []).get(group.id) ?? { flags: [], experiments: [] };

  const remove = useMutation(
    orpc.savedGroups.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.savedGroups.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        setDeleteOpen(false);
        toast.success(t("delete.done", { name: group.name }));
        void navigate({ to: "/saved-groups" });
      },
    }),
  );

  const linkCls = "min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus";

  return (
    <>
      <PageHeader
        breadcrumb={crumbs(group.name)}
        title={group.name}
        description={group.description === "" ? undefined : group.description}
        actions={
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              remove.reset();
              setDeleteOpen(true);
            }}
            className="text-muted"
          >
            <Trash2 className="size-4" />
            {t("common:actions.delete")}
          </Button>
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <SavedGroupForm
          group={group}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
            toast.success(t("detail.saved"), { description: t("detail.savedDescription") });
          }}
        />
        <aside className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-5">
          <h2 className="text-meta font-medium text-muted">{t("detail.usedBy")}</h2>
          {features.isPending || experiments.isPending ? (
            <Skeleton className="h-5 w-40 rounded-md" />
          ) : used.flags.length === 0 && used.experiments.length === 0 ? (
            <p className="text-label text-muted">{t("detail.unused")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-label">
              {used.flags.map((f) => (
                <li key={f.id} className="flex min-w-0 items-center gap-2">
                  <span className="text-meta text-muted">{t("detail.flag")}</span>
                  <Link to="/flags/$featureId" params={{ featureId: f.id }} className={`${linkCls} font-mono`}>
                    {f.key}
                  </Link>
                </li>
              ))}
              {used.experiments.map((x) => (
                <li key={x.id} className="flex min-w-0 items-center gap-2">
                  <Link to="/experiments/$experimentId" params={{ experimentId: x.id }} className={linkCls}>
                    {x.name}
                  </Link>
                  <StatusBadge status={x.status} />
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      <Panel className="mt-6">
        <PanelHeader title={t("detail.history")} />
        <AuditList entityType="savedGroup" entityId={group.id} limit={20} showEntity={false} />
      </Panel>
      <ConfirmDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("delete.title", { name: group.name })}
        confirmLabel={t("delete.confirm")}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => remove.mutate({ id: group.id })}
      >
        <p>{t("delete.body")}</p>
      </ConfirmDialog>
    </>
  );
}
