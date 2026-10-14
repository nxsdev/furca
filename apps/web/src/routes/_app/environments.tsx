import { Button, Description, Drawer, Dropdown, FieldError, Input, Label, Spinner, TextField, toast, Tooltip } from "@heroui/react";
import { type EnvironmentListItem, Key } from "@furca/api/contract";
import type { Environment } from "@furca/core/environments/Environment";
import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FileJson, KeyRound, MoreHorizontal, Plus, RotateCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CodeBlock, Quickstart } from "~/components/environments/Quickstart";
import { formatBytes, TrafficSparkline } from "~/components/environments/Sparkline";
import { FlagSwitch } from "~/components/flags/FlagSwitch";
import { errorText, matches, setServerError, submitHandler, useAppForm, useFieldContext, useRequired } from "~/components/form/form";
import { slugify } from "~/components/metrics/slugify";
import { environmentHue } from "~/components/shell/Sidebar";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { CopyButton, EmptyState, ListSkeleton, PageHeader, Panel, QueryError } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { usePermissions } from "~/lib/permissions";
import { client, errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/environments")({
  head: () => ({ meta: [{ title: i18n.t("environments:pageTitle") }] }),
  component: Page,
});

const LARGE_PAYLOAD = 100 * 1024;

function PayloadSize({ bytes }: { bytes: number | null }) {
  const { t } = useTranslation("environments");
  if (bytes === null) return <span className="text-muted">{t("payloadSize.notPublished")}</span>;
  if (bytes <= LARGE_PAYLOAD) return <span className="font-mono tabular">{formatBytes(bytes)}</span>;
  return (
    <Tooltip delay={200}>
      <Tooltip.Trigger className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <TriangleAlert className="size-3.5 text-health" aria-hidden="true" />
        <span className="font-mono tabular">{formatBytes(bytes)}</span>
        <span className="text-meta text-muted">{t("payloadSize.large")}</span>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-64">{t("payloadSize.largeHint")}</Tooltip.Content>
    </Tooltip>
  );
}

/** Kit TextField plus isRequired / autoFocus / spellCheck, which this inline row needs */
function RowField({
  label,
  placeholder,
  description,
  mono = false,
  autoFocus = false,
}: {
  label: string;
  placeholder: string;
  description?: string;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  const field = useFieldContext<string>();
  const shown = field.state.meta.isTouched || field.form.state.submissionAttempts > 0;
  const error = shown ? errorText(field.state.meta.errors) : "";
  return (
    <TextField
      name={field.name}
      value={field.state.value}
      onChange={field.handleChange}
      onBlur={field.handleBlur}
      isRequired
      isInvalid={error !== ""}
      autoFocus={autoFocus}
      validationBehavior="aria"
      className="sm:w-56"
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} spellCheck={mono ? false : undefined} className={mono ? "font-mono" : undefined} />
      {description !== undefined && <Description>{description}</Description>}
      <FieldError>{error}</FieldError>
    </TextField>
  );
}

function CreateEnvironment({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(["environments", "common"]);
  const queryClient = useQueryClient();
  const required = useRequired();
  const keyPattern = matches(Key, () => t("create.keyInvalid"));
  const form = useAppForm({
    defaultValues: { name: "", key: "" },
    onSubmit: async ({ value, formApi }) => {
      try {
        const env = await client.environments.create({ name: value.name.trim(), key: value.key });
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast.success(t("create.created", { name: env.name }), { description: t("create.createdDescription") });
        onDone();
      } catch (e) {
        // BAD_REQUEST is the duplicate-key check (the name is validated here first)
        setServerError(formApi, e, e instanceof ORPCError && e.code === "BAD_REQUEST" ? "key" : undefined);
      }
    },
  });
  return (
    <form
      noValidate
      className="flex flex-col gap-4 border-b border-border bg-default/30 px-5 py-4 sm:flex-row sm:items-start"
      onSubmit={submitHandler(form)}
    >
      <form.AppField
        name="name"
        validators={{ onChange: required }}
        listeners={{
          onChange: ({ value }) => {
            // Follow the name until the key is edited; Japanese names slugify to "", so leave the key alone then
            const slug = slugify(value);
            if (slug !== "" && form.getFieldMeta("key")?.isDirty !== true) form.setFieldValue("key", slug, { dontUpdateMeta: true });
          },
        }}
      >
        {() => <RowField label={t("create.name")} placeholder="Staging" autoFocus />}
      </form.AppField>
      <form.AppField name="key" validators={{ onChange: ({ value }) => required({ value }) ?? keyPattern({ value }) }}>
        {() => <RowField label={t("create.key")} placeholder="staging" description={t("create.keyHelp")} mono />}
      </form.AppField>
      <div className="flex items-center gap-2 sm:mt-6">
        <form.AppForm>
          <form.SubmitButton label={t("common:actions.create")} size="sm" />
        </form.AppForm>
        <Button size="sm" variant="tertiary" onPress={onDone}>
          {t("common:actions.cancel")}
        </Button>
      </div>
      <form.AppForm>
        <form.FormError className="sm:mt-6" />
      </form.AppForm>
    </form>
  );
}

function PayloadDrawer({ env, onClose }: { env: Environment | null; onClose: () => void }) {
  const { t } = useTranslation("environments");
  const payload = useQuery({
    ...orpc.environments.payload.queryOptions({ input: { id: env?.id ?? "" } }),
    enabled: env !== null,
  });
  return (
    <Drawer.Backdrop isOpen={env !== null} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-[min(680px,100vw)] max-w-full gap-0 p-0 sm:w-[680px]">
          <Drawer.CloseTrigger />
          <Drawer.Header className="flex flex-col gap-1 border-b border-border px-5 py-4">
            <Drawer.Heading className="text-section font-semibold">{t("payloadDrawer.title", { name: env?.name ?? "" })}</Drawer.Heading>
            <p className="text-label text-muted">
              <Trans
                t={t}
                i18nKey="payloadDrawer.description"
                values={{ path: "/api/sdk/v1/payload/<sdk key>" }}
                components={{ code: <code className="font-mono" /> }}
              />
            </p>
          </Drawer.Header>
          <Drawer.Body className="min-h-0 flex-1 overflow-auto p-5">
            {payload.isPending ? (
              <div className="flex justify-center py-10">
                <Spinner size="sm" color="current" />
              </div>
            ) : payload.isError ? (
              <QueryError
                message={t("payloadDrawer.loadFailed", { message: errorMessage(payload.error) })}
                onRetry={() => payload.refetch()}
              />
            ) : (
              <>
                <p className="mb-2 text-meta text-muted tabular">{formatBytes(new TextEncoder().encode(payload.data).length)}</p>
                <CodeBlock code={payload.data} label={t("payloadDrawer.copyJson")} className="" />
              </>
            )}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/** Admins switch it; everyone else sees whether changes here wait for a review */
function RequireReviewSwitch({ env }: { env: Environment }) {
  const { t } = useTranslation("environments");
  const queryClient = useQueryClient();
  const { isAdmin } = usePermissions();
  const update = useMutation(
    orpc.environments.setRequireApproval.mutationOptions({
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(saved.requireApproval ? t("review.turnedOn", { name: saved.name }) : t("review.turnedOff", { name: saved.name }));
      },
      onError: (e) => toast.danger(t("review.failed"), { description: errorMessage(e) }),
    }),
  );
  if (!isAdmin) return <span className={env.requireApproval ? "" : "text-muted"}>{env.requireApproval ? t("review.required") : t("review.notRequired")}</span>;
  return (
    <FlagSwitch
      aria-label={t("review.switchLabel", { name: env.name })}
      isSelected={update.isPending ? update.variables.requireApproval : env.requireApproval}
      isDisabled={update.isPending}
      onChange={(requireApproval) => update.mutate({ id: env.id, requireApproval })}
    />
  );
}

function EnvironmentRow({
  item,
  onPayload,
  onRotate,
}: {
  item: EnvironmentListItem;
  onPayload: () => void;
  onRotate: () => void;
}) {
  const { t } = useTranslation("environments");
  const { isAdmin } = usePermissions();
  const env = item.environment;
  return (
    <tr className={tbl.tr}>
      <td className={tbl.td}>
        <span className="flex items-center gap-2.5">
          <span className={`size-2 shrink-0 rounded-full ${environmentHue(env.key)}`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{env.name}</span>
            <code className="block truncate font-mono text-meta text-muted">{env.key}</code>
            <span className="relative z-1 flex items-center gap-1 sm:hidden">
              <code className="max-w-[140px] truncate font-mono text-meta">{env.sdkKey}</code>
              <CopyButton value={env.sdkKey} label={t("row.copySdkKey")} />
            </span>
          </span>
        </span>
      </td>
      <td className={`${tbl.td} hidden sm:table-cell`}>
        <span className="flex items-center gap-1">
          <code className="max-w-[220px] truncate font-mono">{env.sdkKey}</code>
          <CopyButton value={env.sdkKey} label={t("row.copySdkKey")} />
        </span>
      </td>
      <td className={`${tbl.td} hidden whitespace-nowrap sm:table-cell`}>
        <PayloadSize bytes={item.payloadBytes} />
      </td>
      <td className={`${tbl.td} hidden text-right font-mono tabular md:table-cell`}>{item.featureCount}</td>
      {/* The Review column needs the room below 1400px */}
      <td className={`${tbl.td} hidden min-[1400px]:table-cell`}>
        <TrafficSparkline environmentId={env.id} />
      </td>
      <td className={`${tbl.td} w-px whitespace-nowrap`}>
        <RequireReviewSwitch env={env} />
      </td>
      <td className={`${tbl.td} w-px whitespace-nowrap text-right`}>
        <span className="inline-flex items-center gap-1">
          <Button size="sm" variant="ghost" onPress={onPayload} className="h-8">
            <FileJson className="size-4" />
            <span className="hidden sm:inline">{t("row.payload")}</span>
          </Button>
          {isAdmin && <Dropdown>
            <Button isIconOnly size="sm" variant="ghost" aria-label={t("row.moreActions", { name: env.name })} className="size-8 min-w-8">
              <MoreHorizontal className="size-4" />
            </Button>
            <Dropdown.Popover placement="bottom end" className="min-w-48">
              <Dropdown.Menu onAction={(k) => k === "rotate" && onRotate()}>
                <Dropdown.Item id="rotate" textValue={t("row.rotateSdkKey")} variant="danger">
                  <RotateCw className="size-4" />
                  <Label>{t("row.rotateSdkKeyMenu")}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>}
        </span>
      </td>
    </tr>
  );
}

function Page() {
  const { t } = useTranslation("environments");
  const queryClient = useQueryClient();
  const { isAdmin } = usePermissions();
  const list = useQuery(orpc.environments.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const [payloadEnv, setPayloadEnv] = useState<Environment | null>(null);
  // Target outlives `rotateOpen` so the dialog keeps its text during the exit animation
  const [rotating, setRotating] = useState<Environment | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const rotate = useMutation(
    orpc.environments.rotateSdkKey.mutationOptions({
      onSuccess: (env) => {
        void queryClient.invalidateQueries({ queryKey: orpc.environments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        setRotateOpen(false);
        toast.success(t("rotate.done", { name: env.name }), { description: t("rotate.doneDescription") });
      },
    }),
  );

  return (
    <>
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          isAdmin && (
            <Button size="sm" onPress={() => setCreating(true)} isDisabled={creating}>
              <Plus className="size-4" />
              {t("page.newEnvironment")}
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-6">
        {list.isPending ? (
          <Panel>
            <ListSkeleton rows={3} />
          </Panel>
        ) : list.isError ? (
          <QueryError message={t("page.loadFailed", { message: errorMessage(list.error) })} onRetry={() => list.refetch()} />
        ) : list.data.length === 0 && !creating ? (
          <EmptyState
            icon={<KeyRound />}
            title={t("page.emptyTitle")}
            description={t("page.emptyDescription")}
            action={
              isAdmin && (
                <Button size="sm" onPress={() => setCreating(true)}>
                  {t("page.newEnvironment")}
                </Button>
              )
            }
          />
        ) : (
          <Panel>
            {creating && <CreateEnvironment onDone={() => setCreating(false)} />}
            <div className="overflow-x-auto">
              <table className={tbl.table}>
                <thead>
                  <tr>
                    <th className={tbl.th}>{t("table.environment")}</th>
                    <th className={`${tbl.th} hidden sm:table-cell`}>{t("table.sdkKey")}</th>
                    <th className={`${tbl.th} hidden sm:table-cell`}>{t("table.payload")}</th>
                    <th className={`${tbl.th} hidden text-right md:table-cell`}>{t("table.flagsOn")}</th>
                    <th className={`${tbl.th} hidden min-[1400px]:table-cell`}>{t("table.last24h")}</th>
                    <th className={tbl.th}>{t("table.review")}</th>
                    <th className={tbl.th}>
                      <span className="sr-only">{t("table.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((item) => (
                    <EnvironmentRow
                      key={item.environment.id}
                      item={item}
                      onPayload={() => setPayloadEnv(item.environment)}
                      onRotate={() => {
                        setRotating(item.environment);
                        rotate.reset();
                        setRotateOpen(true);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="flex items-start gap-2 border-t border-border px-5 py-3 text-meta text-muted">
              <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              {t("review.help")}
            </p>
          </Panel>
        )}
        <Quickstart />
      </div>

      <PayloadDrawer env={payloadEnv} onClose={() => setPayloadEnv(null)} />
      <ConfirmDialog
        isOpen={rotateOpen}
        onOpenChange={setRotateOpen}
        title={t("rotate.title", { name: rotating?.name ?? "" })}
        confirmLabel={t("rotate.confirm")}
        isPending={rotate.isPending}
        error={rotate.error === null ? null : errorMessage(rotate.error)}
        onConfirm={() => rotating !== null && rotate.mutate({ id: rotating.id })}
      >
        <p>
          <Trans
            t={t}
            i18nKey="rotate.body"
            values={{ sdkKey: rotating?.sdkKey ?? "" }}
            components={{ code: <code className="break-all font-mono text-foreground" /> }}
          />
        </p>
      </ConfirmDialog>
    </>
  );
}
