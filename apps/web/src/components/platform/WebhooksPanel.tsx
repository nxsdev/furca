import { Button, Checkbox, CheckboxGroup, Description, FieldError, Label, toast } from "@heroui/react";
import type { Webhook, WebhookEvent, WebhookFormat } from "@furca/core/platform/Webhook";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText, setServerError, submitHandler, useAppForm, useRequired } from "~/components/form/form";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { ListSkeleton, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { Segmented } from "~/components/ui/Segmented";
import { tbl } from "~/components/ui/table";
import { client, errorMessage, orpc } from "~/lib/rpc";
import { SecretOnce } from "./ApiKeysPanel";

const EVENTS: ReadonlyArray<WebhookEvent> = ["flag.updated", "experiment.started", "experiment.phase_started", "experiment.stopped", "payload.updated"];
/** i18n key segment: dots would nest */
const eventKey = (e: WebhookEvent) => e.replace(".", "_") as "flag_updated";

const isHttpUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
};

function WebhookForm({
  webhook,
  onSaved,
  onCancel,
}: {
  /** null: create */
  webhook: Webhook | null;
  onSaved: (secret: string | null) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["platform", "common"]);
  const queryClient = useQueryClient();
  const required = useRequired();
  const form = useAppForm({
    defaultValues: {
      name: webhook?.name ?? "",
      url: webhook?.url ?? "",
      format: webhook?.format ?? ("json" as WebhookFormat),
      events: [...(webhook?.events ?? ["flag.updated", "experiment.started", "experiment.stopped"])] as Array<WebhookEvent>,
      enabled: webhook?.enabled ?? true,
    },
    onSubmit: async ({ value, formApi }) => {
      const fields = { name: value.name.trim(), url: value.url.trim(), format: value.format, events: value.events };
      try {
        const secret =
          webhook === null
            ? (await client.webhooks.create(fields)).secret
            : (await client.webhooks.update({ id: webhook.id, ...fields, enabled: value.enabled }), null);
        void queryClient.invalidateQueries({ queryKey: orpc.webhooks.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        onSaved(value.format === "json" ? secret : null);
      } catch (e) {
        setServerError(formApi, e);
      }
    },
  });
  return (
    <form noValidate className="flex flex-col gap-4 border-b border-border bg-default/30 px-5 py-4" onSubmit={submitHandler(form)}>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <form.AppField name="name" validators={{ onSubmit: required }}>
          {(field) => <field.TextField label={t("webhooks.form.name")} placeholder={t("webhooks.form.namePlaceholder")} />}
        </form.AppField>
        <form.AppField
          name="url"
          validators={{
            onBlur: ({ value }) => (value.trim() === "" || isHttpUrl(value) ? undefined : t("webhooks.form.urlInvalid")),
            onSubmit: ({ value }) => required({ value }) ?? (isHttpUrl(value) ? undefined : t("webhooks.form.urlInvalid")),
          }}
        >
          {(field) => <field.TextField label={t("webhooks.form.url")} type="url" placeholder="https://hooks.slack.com/services/…" mono />}
        </form.AppField>
      </div>
      <form.AppField name="format">
        {(field) => (
          <Segmented
            label={t("webhooks.form.format")}
            value={field.state.value}
            onChange={field.handleChange}
            options={(["json", "slack"] as const).map((f) => ({
              value: f,
              label: t(`webhooks.format.${f}`),
              description: t(`webhooks.formatHelp.${f}`),
            }))}
          />
        )}
      </form.AppField>
      <form.AppField
        name="events"
        validators={{ onSubmit: ({ value }) => (value.length === 0 ? t("webhooks.form.eventsRequired") : undefined) }}
      >
        {(field) => {
          const error = field.form.state.submissionAttempts > 0 ? errorText(field.state.meta.errors) : "";
          return (
            <CheckboxGroup
              value={field.state.value}
              onChange={(v) => field.handleChange(v as Array<WebhookEvent>)}
              isInvalid={error !== ""}
              className="flex flex-col gap-2"
            >
              <Label>{t("webhooks.form.events")}</Label>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {EVENTS.map((e) => (
                  <Checkbox key={e} value={e}>
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span className="flex flex-col">
                        <span className="text-label">{t(`webhooks.events.${eventKey(e)}.label`)}</span>
                        <span className="text-xs text-muted">{t(`webhooks.events.${eventKey(e)}.help`)}</span>
                      </span>
                    </Checkbox.Content>
                  </Checkbox>
                ))}
              </div>
              <Description>{t("webhooks.form.eventsHelp")}</Description>
              <FieldError>{error}</FieldError>
            </CheckboxGroup>
          );
        }}
      </form.AppField>
      {webhook !== null && (
        <form.AppField name="enabled">
          {(field) => <field.SwitchField label={t("webhooks.form.enabled")} description={t("webhooks.form.enabledHelp")} className="max-w-xl" />}
        </form.AppField>
      )}
      <form.AppForm>
        <form.FormError />
      </form.AppForm>
      <div className="flex items-center gap-2">
        <form.AppForm>
          <form.SubmitButton size="sm" label={webhook === null ? t("webhooks.form.create") : t("common:actions.save")} />
        </form.AppForm>
        <Button size="sm" variant="tertiary" onPress={onCancel}>
          {t("common:actions.cancel")}
        </Button>
      </div>
    </form>
  );
}

function LastDelivery({ webhook }: { webhook: Webhook }) {
  const { t } = useTranslation("platform");
  if (webhook.lastDeliveredAt === null) return <span className="text-muted">{t("webhooks.neverDelivered")}</span>;
  const failed = webhook.lastError !== null;
  return (
    <span className="flex max-w-[240px] flex-col">
      <span className={`truncate whitespace-nowrap ${failed ? "text-health" : ""}`} title={webhook.lastError ?? undefined}>
        {failed ? t("webhooks.failed", { error: webhook.lastError }) : t("webhooks.delivered", { status: webhook.lastStatus })}
      </span>
      <span className="text-meta text-muted">
        <RelativeTime date={webhook.lastDeliveredAt} />
      </span>
    </span>
  );
}

export function WebhooksPanel() {
  const { t } = useTranslation(["platform", "common"]);
  const queryClient = useQueryClient();
  const list = useQuery(orpc.webhooks.list.queryOptions());
  /** "new", a webhook id being edited, or null */
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const test = useMutation(
    orpc.webhooks.test.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.webhooks.key() });
        if (result.error === null) toast.success(t("webhooks.testOk", { status: result.status }));
        else toast.danger(t("webhooks.testFailed"), { description: result.error });
      },
      onError: (e) => toast.danger(t("webhooks.testFailed"), { description: errorMessage(e) }),
    }),
  );
  const remove = useMutation(
    orpc.webhooks.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.webhooks.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(t("webhooks.deleted", { name: deleting?.name ?? "" }));
        setDeleteOpen(false);
      },
    }),
  );
  const editingHook = list.data?.find((w) => w.id === editing) ?? null;
  return (
    <Panel>
      <PanelHeader
        title={t("webhooks.title")}
        description={t("webhooks.description")}
        actions={
          editing !== "new" && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                setSecret(null);
                setEditing("new");
              }}
            >
              <Plus className="size-4" />
              {t("webhooks.create")}
            </Button>
          )
        }
      />
      {editing === "new" && (
        <WebhookForm
          webhook={null}
          onCancel={() => setEditing(null)}
          onSaved={(s) => {
            setEditing(null);
            setSecret(s);
            if (s === null) toast.success(t("webhooks.created"));
          }}
        />
      )}
      {secret !== null && (
        <SecretOnce title={t("webhooks.secretTitle")} secret={secret} warning={t("webhooks.secretWarning")} onDismiss={() => setSecret(null)} />
      )}
      {list.isPending ? (
        <ListSkeleton rows={2} />
      ) : list.isError ? (
        <div className="p-4">
          <QueryError message={t("webhooks.loadFailed", { message: errorMessage(list.error) })} onRetry={() => list.refetch()} />
        </div>
      ) : list.data.length === 0 ? (
        editing !== "new" && (
          <div className="flex items-start gap-3 px-5 py-5 text-body text-muted">
            <WebhookIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="max-w-[64ch]">{t("webhooks.empty")}</p>
          </div>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>{t("webhooks.name")}</th>
                <th className={`${tbl.th} hidden md:table-cell`}>{t("webhooks.eventsColumn")}</th>
                <th className={`${tbl.th} hidden sm:table-cell`}>{t("webhooks.lastDelivery")}</th>
                <th className={tbl.th}>
                  <span className="sr-only">{t("webhooks.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((w) =>
                editing === w.id && editingHook !== null ? (
                  <tr key={w.id} className="border-b border-border last:border-b-0">
                    <td colSpan={4} className="p-0">
                      <WebhookForm
                        webhook={editingHook}
                        onCancel={() => setEditing(null)}
                        onSaved={() => {
                          setEditing(null);
                          toast.success(t("webhooks.saved", { name: w.name }));
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={w.id} className={tbl.tr}>
                    <td className={`${tbl.td} max-w-[320px]`}>
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{w.name}</span>
                        <span className="rounded-[5px] border border-border px-1.5 text-meta font-medium text-muted">
                          {t(`webhooks.format.${w.format}`)}
                        </span>
                        {!w.enabled && <span className="text-meta text-muted">{t("webhooks.paused")}</span>}
                      </span>
                      <span className="block truncate font-mono text-meta text-muted">{w.url}</span>
                    </td>
                    <td className={`${tbl.td} hidden max-w-[260px] text-muted md:table-cell`}>
                      <span className="line-clamp-2">{w.events.map((e) => t(`webhooks.events.${eventKey(e)}.label`)).join(", ")}</span>
                    </td>
                    <td className={`${tbl.td} hidden sm:table-cell`}>
                      <LastDelivery webhook={w} />
                    </td>
                    <td className={`${tbl.td} w-px whitespace-nowrap text-right`}>
                      <span className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-muted"
                          isPending={test.isPending && test.variables?.id === w.id}
                          onPress={() => test.mutate({ id: w.id })}
                        >
                          <Send className="size-3.5" />
                          {t("webhooks.test")}
                        </Button>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={t("webhooks.edit", { name: w.name })}
                          className="size-8 min-w-8 text-muted"
                          onPress={() => setEditing(w.id)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={t("webhooks.delete", { name: w.name })}
                          className="size-8 min-w-8 text-muted"
                          onPress={() => {
                            setDeleting(w);
                            remove.reset();
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("webhooks.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("webhooks.deleteConfirm")}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => deleting !== null && remove.mutate({ id: deleting.id })}
      >
        <p>{t("webhooks.deleteBody")}</p>
      </ConfirmDialog>
    </Panel>
  );
}
