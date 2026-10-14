import { Button, Dropdown, Label, toast } from "@heroui/react";
import { Key, type NamespaceListItem } from "@furca/api/contract";
import type { Namespace } from "@furca/core/experiments/Namespace";
import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Layers, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "~/components/experiments/parts";
import { matches, setServerError, submitHandler, useAppForm, useRequired } from "~/components/form/form";
import { slugify } from "~/components/metrics/slugify";
import { freeShare } from "~/components/namespaces/allocation";
import { AllocationBar, percentLabel, rangeLabel } from "~/components/namespaces/AllocationBar";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { EmptyState, ListSkeleton, PageHeader, Panel, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { usePermissions } from "~/lib/permissions";
import { client, errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/namespaces")({
  head: () => ({ meta: [{ title: i18n.t("namespaces:pageTitle") }] }),
  component: Page,
});

/** Inline create / edit row: name, key (create only), description */
function NamespaceEditor({ namespace, onDone }: { namespace?: Namespace; onDone: () => void }) {
  const { t } = useTranslation(["namespaces", "common"]);
  const queryClient = useQueryClient();
  const required = useRequired();
  const keyPattern = matches(Key, () => t("form.keyInvalid"));
  const isEdit = namespace !== undefined;
  const form = useAppForm({
    defaultValues: { name: namespace?.name ?? "", key: namespace?.key ?? "", description: namespace?.description ?? "" },
    onSubmit: async ({ value, formApi }) => {
      try {
        const saved = isEdit
          ? await client.namespaces.update({ id: namespace.id, name: value.name.trim(), description: value.description.trim() })
          : await client.namespaces.create({ key: value.key, name: value.name.trim(), description: value.description.trim() });
        void queryClient.invalidateQueries({ queryKey: orpc.namespaces.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast.success(isEdit ? t("form.saved") : t("form.created", { name: saved.name }));
        onDone();
      } catch (e) {
        // BAD_REQUEST on create is the duplicate-key check (the name is validated here first)
        setServerError(formApi, e, !isEdit && e instanceof ORPCError && e.code === "BAD_REQUEST" ? "key" : undefined);
      }
    },
  });
  return (
    <form noValidate onSubmit={submitHandler(form)} className="flex flex-col gap-4 bg-default/30 px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,14rem)_minmax(0,1fr)]">
        <form.AppField
          name="name"
          validators={{ onChange: required }}
          listeners={{
            onChange: ({ value }) => {
              // Follow the name until the key is edited; names without a Latin spelling leave the key alone
              const slug = slugify(value);
              if (!isEdit && slug !== "" && form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", slug, { dontUpdateMeta: true });
            },
          }}
        >
          {(field) => <field.TextField label={t("form.name")} placeholder={t("form.namePlaceholder")} />}
        </form.AppField>
        <form.AppField name="key" validators={isEdit ? undefined : { onChange: ({ value }) => required({ value }) ?? keyPattern({ value }) }}>
          {(field) => (
            <field.TextField label={t("form.key")} placeholder="checkout" description={isEdit ? t("form.keyLocked") : t("form.keyHelp")} isReadOnly={isEdit} mono />
          )}
        </form.AppField>
        <form.AppField name="description">
          {(field) => <field.TextField label={t("form.description")} placeholder={t("form.descriptionPlaceholder")} />}
        </form.AppField>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form.AppForm>
          <form.SubmitButton label={isEdit ? t("common:actions.save") : t("common:actions.create")} size="sm" />
        </form.AppForm>
        <Button size="sm" variant="tertiary" onPress={onDone}>
          {t("common:actions.cancel")}
        </Button>
        <form.AppForm>
          <form.FormError />
        </form.AppForm>
      </div>
    </form>
  );
}

function NamespaceRow({ item, onEdit, onDelete }: { item: NamespaceListItem; onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation("namespaces");
  const { canEdit } = usePermissions();
  const { namespace: ns, allocations } = item;
  return (
    <tr className={`${tbl.tr} hover:bg-transparent`}>
      <td className={`${tbl.td} w-[30%] py-3 align-top`}>
        <span className="block truncate font-medium">{ns.name}</span>
        <code className="block truncate font-mono text-meta text-muted">{ns.key}</code>
        {ns.description !== "" && <p className="mt-1 text-meta text-muted">{ns.description}</p>}
      </td>
      <td className={`${tbl.td} py-3 align-top`}>
        <AllocationBar allocations={allocations} />
        {allocations.length === 0 ? (
          <p className="mt-1 text-meta text-muted">{t("row.noExperiments")}</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1">
            {allocations.map((a) => (
              <li key={a.experimentId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label">
                <Link
                  to="/experiments/$experimentId"
                  params={{ experimentId: a.experimentId }}
                  className="min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {a.experimentName}
                </Link>
                <StatusBadge status={a.status} />
                <span className="font-mono text-meta text-muted tabular">{rangeLabel(a)}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap py-3 text-right align-top font-mono tabular sm:table-cell`}>
        {percentLabel(freeShare(allocations))}
      </td>
      <td className={`${tbl.td} w-px py-3 text-right align-top`}>
        {canEdit && <Dropdown>
          <Button isIconOnly size="sm" variant="ghost" aria-label={t("row.moreActions", { name: ns.name })} className="size-8 min-w-8">
            <MoreHorizontal className="size-4" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-44">
            <Dropdown.Menu onAction={(k) => (k === "edit" ? onEdit() : k === "delete" ? onDelete() : undefined)}>
              <Dropdown.Item id="edit" textValue={t("row.edit")}>
                <Pencil className="size-4" />
                <Label>{t("row.edit")}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="delete" textValue={t("row.delete")} variant="danger">
                <Trash2 className="size-4" />
                <Label>{t("row.delete")}</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>}
      </td>
    </tr>
  );
}

function Page() {
  const { t } = useTranslation("namespaces");
  const queryClient = useQueryClient();
  const list = useQuery(orpc.namespaces.list.queryOptions());
  const { canEdit } = usePermissions();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Target outlives `deleteOpen` so the dialog keeps its text during the exit animation
  const [deleting, setDeleting] = useState<Namespace | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const remove = useMutation(
    orpc.namespaces.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.namespaces.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        setDeleteOpen(false);
        toast.success(t("delete.done", { name: deleting?.name ?? "" }));
      },
    }),
  );
  const newButton = canEdit && (
    <Button size="sm" onPress={() => setCreating(true)} isDisabled={creating}>
      <Plus className="size-4" />
      {t("page.new")}
    </Button>
  );

  return (
    <>
      <PageHeader title={t("page.title")} description={t("page.description")} actions={newButton} />
      {list.isPending ? (
        <Panel>
          <ListSkeleton rows={3} />
        </Panel>
      ) : list.isError ? (
        <QueryError message={t("page.loadFailed", { message: errorMessage(list.error) })} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 && !creating ? (
        <EmptyState icon={<Layers />} title={t("page.emptyTitle")} description={t("page.emptyDescription")} action={newButton} />
      ) : (
        <Panel>
          {creating && (
            <div className="border-b border-border">
              <NamespaceEditor onDone={() => setCreating(false)} />
            </div>
          )}
          {list.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>{t("table.namespace")}</th>
                    <th className={tbl.th}>{t("table.allocation")}</th>
                    <th className={`${tbl.th} hidden text-right sm:table-cell`}>{t("table.free")}</th>
                    <th className={tbl.th}>
                      <span className="sr-only">{t("table.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((item) =>
                    editingId === item.namespace.id ? (
                      <tr key={item.namespace.id} className="border-b border-border last:border-b-0">
                        <td colSpan={4} className="p-0">
                          <NamespaceEditor namespace={item.namespace} onDone={() => setEditingId(null)} />
                        </td>
                      </tr>
                    ) : (
                      <NamespaceRow
                        key={item.namespace.id}
                        item={item}
                        onEdit={() => setEditingId(item.namespace.id)}
                        onDelete={() => {
                          setDeleting(item.namespace);
                          remove.reset();
                          setDeleteOpen(true);
                        }}
                      />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      <ConfirmDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("delete.title", { name: deleting?.name ?? "" })}
        confirmLabel={t("delete.confirm")}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => deleting !== null && remove.mutate({ id: deleting.id })}
      >
        <p>{t("delete.body")}</p>
      </ConfirmDialog>
    </>
  );
}
