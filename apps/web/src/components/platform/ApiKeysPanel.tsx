import { Button, toast } from "@heroui/react";
import type { ApiKey } from "@furca/core/platform/ApiKey";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CodeBlock } from "~/components/environments/Quickstart";
import { setServerError, submitHandler, useAppForm, useRequired } from "~/components/form/form";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Code, CopyButton, ListSkeleton, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { client, errorMessage, orpc } from "~/lib/rpc";

function CreateKeyForm({ onCreated, onCancel }: { onCreated: (created: { apiKey: ApiKey; secret: string }) => void; onCancel: () => void }) {
  const { t } = useTranslation(["platform", "common"]);
  const queryClient = useQueryClient();
  const required = useRequired();
  const form = useAppForm({
    defaultValues: { name: "", role: "admin" as ApiKey["role"] },
    onSubmit: async ({ value, formApi }) => {
      try {
        const created = await client.apiKeys.create({ name: value.name.trim(), role: value.role });
        void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        onCreated(created);
      } catch (e) {
        setServerError(formApi, e);
      }
    },
  });
  return (
    <form noValidate className="flex flex-col gap-3 border-b border-border bg-default/30 px-5 py-4" onSubmit={submitHandler(form)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <form.AppField name="name" validators={{ onSubmit: required }}>
          {(field) => <field.TextField label={t("apiKeys.form.name")} placeholder={t("apiKeys.form.namePlaceholder")} className="sm:w-64" />}
        </form.AppField>
        <form.AppField name="role">
          {(field) => (
            <field.SelectField
              label={t("apiKeys.form.role")}
              className="sm:w-48"
              options={(["admin", "readonly"] as const).map((r) => ({ id: r, label: t(`apiKeys.role.${r}`), textValue: t(`apiKeys.role.${r}`) }))}
            />
          )}
        </form.AppField>
        <div className="flex items-center gap-2 sm:mt-6">
          <form.AppForm>
            <form.SubmitButton size="sm" label={t("apiKeys.form.submit")} />
          </form.AppForm>
          <Button size="sm" variant="tertiary" onPress={onCancel}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
      <form.Subscribe selector={(s) => s.values.role}>
        {(role) => <p className="text-xs text-muted">{t(`apiKeys.roleHelp.${role}`)}</p>}
      </form.Subscribe>
      <form.AppForm>
        <form.FormError />
      </form.AppForm>
    </form>
  );
}

/** The secret, shown once right after creation */
export function SecretOnce({ title, secret, warning, onDismiss }: { title: string; secret: string; warning: string; onDismiss: () => void }) {
  const { t } = useTranslation("platform");
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-default/30 px-5 py-4" role="status">
      <p className="text-label font-medium">{title}</p>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-label">{secret}</code>
        <CopyButton value={secret} label={t("secret.copy")} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{warning}</p>
        <Button size="sm" variant="ghost" onPress={onDismiss} className="h-7">
          {t("secret.done")}
        </Button>
      </div>
    </div>
  );
}

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: () => void }) {
  const { t } = useTranslation("platform");
  const revoked = apiKey.revokedAt !== null;
  return (
    <tr className={`${tbl.tr} ${revoked ? "text-muted" : ""}`}>
      <td className={`${tbl.td} max-w-[260px]`}>
        <span className="block truncate font-medium">{apiKey.name}</span>
        <Code className="mt-0.5">{`${apiKey.prefix}…`}</Code>
      </td>
      <td className={tbl.td}>{t(`apiKeys.role.${apiKey.role}`)}</td>
      <td className={`${tbl.td} hidden max-w-[220px] truncate text-muted md:table-cell`}>{apiKey.createdBy}</td>
      <td className={`${tbl.td} hidden text-muted sm:table-cell`}>
        {apiKey.lastUsedAt === null ? t("apiKeys.neverUsed") : <RelativeTime date={apiKey.lastUsedAt} />}
      </td>
      <td className={`${tbl.td} w-px whitespace-nowrap text-right`}>
        {revoked ? (
          <span className="text-meta">
            <Trans t={t} i18nKey="apiKeys.revokedAt" components={{ relative: <RelativeTime date={apiKey.revokedAt!} /> }} />
          </span>
        ) : (
          <Button size="sm" variant="ghost" className="h-8 text-muted" onPress={onRevoke}>
            {t("apiKeys.revoke")}
          </Button>
        )}
      </td>
    </tr>
  );
}

const curlExample = (origin: string) => `curl -X POST ${origin}/api/v1/features/list \\
  -H "Authorization: Bearer furca_…" \\
  -H "content-type: application/json" \\
  -d '{"includeArchived":false}'`;

export function ApiKeysPanel() {
  const { t } = useTranslation(["platform", "common"]);
  const queryClient = useQueryClient();
  const list = useQuery(orpc.apiKeys.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ apiKey: ApiKey; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const revoke = useMutation(
    orpc.apiKeys.revoke.mutationOptions({
      onSuccess: (key) => {
        void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(t("apiKeys.revoked", { name: key.name }));
        setRevokeOpen(false);
      },
    }),
  );
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Panel>
      <PanelHeader
        title={t("apiKeys.title")}
        description={t("apiKeys.description")}
        actions={
          !creating && (
            <Button size="sm" variant="secondary" onPress={() => setCreating(true)}>
              <Plus className="size-4" />
              {t("apiKeys.create")}
            </Button>
          )
        }
      />
      {creating && (
        <CreateKeyForm
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            setCreated(c);
            setCreating(false);
          }}
        />
      )}
      {created !== null && (
        <SecretOnce
          title={t("apiKeys.createdTitle", { name: created.apiKey.name })}
          secret={created.secret}
          warning={t("apiKeys.createdWarning")}
          onDismiss={() => setCreated(null)}
        />
      )}
      {list.isPending ? (
        <ListSkeleton rows={2} />
      ) : list.isError ? (
        <div className="p-4">
          <QueryError message={t("apiKeys.loadFailed", { message: errorMessage(list.error) })} onRetry={() => list.refetch()} />
        </div>
      ) : list.data.length === 0 ? (
        <div className="flex items-start gap-3 px-5 py-5 text-body text-muted">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="max-w-[64ch]">{t("apiKeys.empty")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>{t("apiKeys.name")}</th>
                <th className={tbl.th}>{t("apiKeys.roleColumn")}</th>
                <th className={`${tbl.th} hidden md:table-cell`}>{t("apiKeys.createdBy")}</th>
                <th className={`${tbl.th} hidden sm:table-cell`}>{t("apiKeys.lastUsed")}</th>
                <th className={tbl.th}>
                  <span className="sr-only">{t("apiKeys.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((k) => (
                <KeyRow
                  key={k.id}
                  apiKey={k}
                  onRevoke={() => {
                    setRevoking(k);
                    revoke.reset();
                    setRevokeOpen(true);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-label font-medium">{t("rest.title")}</h3>
          <a
            href="/api/v1/openapi.json"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 rounded-sm text-label text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {t("rest.spec")}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
        </div>
        <p className="max-w-[72ch] text-label text-muted">{t("rest.description")}</p>
        <CodeBlock code={curlExample(origin)} label={t("rest.copyCurl")} className="max-h-60" />
      </div>
      <ConfirmDialog
        isOpen={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={t("apiKeys.revokeTitle", { name: revoking?.name ?? "" })}
        confirmLabel={t("apiKeys.revokeConfirm")}
        isPending={revoke.isPending}
        error={revoke.error === null ? null : errorMessage(revoke.error)}
        onConfirm={() => revoking !== null && revoke.mutate({ id: revoking.id })}
      >
        <p>{t("apiKeys.revokeBody")}</p>
      </ConfirmDialog>
    </Panel>
  );
}
