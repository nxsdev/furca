import { Button, ListBox, Select, toast } from "@heroui/react";
import type { AssignableRole, Invitation, Member, Role } from "@furca/core/members/Member";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Link2 } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { setServerError, submitHandler, useAppForm, useRequired } from "~/components/form/form";
import { ApiKeysPanel } from "~/components/platform/ApiKeysPanel";
import { WebhooksPanel } from "~/components/platform/WebhooksPanel";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { CopyButton, ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n, intlLocale } from "~/i18n";
import { usePermissions } from "~/lib/permissions";
import { client, errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: i18n.t("settings:pageTitle") }] }),
  component: Page,
});

const REPO = "https://github.com/nxsdev/furca";
const fullUrl = (inv: Invitation) => new URL(inv.url, window.location.origin).toString();
const formatJoined = (d: Date) => d.toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES: ReadonlyArray<Role> = ["owner", "admin", "editor", "viewer"];
const ASSIGNABLE: ReadonlyArray<AssignableRole> = ["admin", "editor", "viewer"];

function InviteForm({ onCreated }: { onCreated: (inv: Invitation) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const required = useRequired();
  const form = useAppForm({
    defaultValues: { email: "", role: "editor" as AssignableRole },
    onSubmit: async ({ value, formApi }) => {
      try {
        const inv = await client.members.invite({ email: value.email.trim(), role: value.role });
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        formApi.reset();
        onCreated(inv);
      } catch (e) {
        // BAD_REQUEST: invalid address or already a member
        setServerError(formApi, e);
      }
    },
  });
  return (
    <form noValidate className="flex flex-col gap-2 border-b border-border px-5 py-4" onSubmit={submitHandler(form)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <form.AppField
          name="email"
          validators={{
            // Empty is only an error on submit, so tabbing through the field stays quiet
            onBlur: ({ value }) => (value.trim() === "" || EMAIL.test(value.trim()) ? undefined : t("common:form.email")),
            onSubmit: required,
          }}
          // Once the format error shows, re-check while typing so it clears as soon as the address is valid
          listeners={{
            onChange: ({ fieldApi }) => {
              if (fieldApi.state.meta.errorMap.onBlur !== undefined) fieldApi.validate("blur");
            },
          }}
        >
          {(field) => (
            <field.TextField
              label={t("invite.label")}
              type="email"
              placeholder="teammate@company.com"
              autoComplete="off"
              className="sm:w-80"
            />
          )}
        </form.AppField>
        <form.AppField name="role">
          {(field) => (
            <field.SelectField
              label={t("invite.role")}
              options={ASSIGNABLE.map((r) => ({ id: r, label: t(`roles.${r}`), textValue: t(`roles.${r}`) }))}
              className="sm:w-36"
            />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton
            size="sm"
            className="h-9 sm:mt-6"
            label={
              <>
                <Link2 className="size-4" />
                {t("invite.submit")}
              </>
            }
          />
        </form.AppForm>
      </div>
      <form.AppForm>
        <form.FormError />
      </form.AppForm>
      <p className="text-xs text-muted">{t("invite.help")}</p>
    </form>
  );
}

function CreatedInvite({ invitation, onDismiss }: { invitation: Invitation; onDismiss: () => void }) {
  const { t } = useTranslation("settings");
  const url = fullUrl(invitation);
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-default/30 px-5 py-4" role="status">
      <p className="text-label">
        <Trans
          t={t}
          i18nKey="invite.createdFor"
          values={{ email: invitation.email }}
          components={{ strong: <span className="font-medium" /> }}
        />
      </p>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-label">{url}</code>
        <CopyButton value={url} label={t("invite.copyLink")} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          <Trans t={t} i18nKey="invite.createdExpires" components={{ relative: <RelativeTime date={invitation.expiresAt} /> }} />
        </p>
        <Button size="sm" variant="ghost" onPress={onDismiss} className="h-7">
          {t("invite.done")}
        </Button>
      </div>
    </div>
  );
}

function RoleSelect({ member }: { member: Member }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const name = member.name || member.email;
  const setRole = useMutation(
    orpc.members.setRole.mutationOptions({
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.session.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(t("members.roleUpdated", { name, role: t(`roles.${saved.role}`) }));
      },
      onError: (e) => toast.danger(t("members.roleFailed"), { description: errorMessage(e) }),
    }),
  );
  return (
    <Select
      aria-label={t("members.roleOf", { name })}
      value={member.role}
      isDisabled={setRole.isPending}
      onChange={(role) => {
        if (role === "admin" || role === "editor" || role === "viewer") setRole.mutate({ id: member.id, role });
      }}
      className="w-28"
    >
      <Select.Trigger className="h-8">
        <Select.Value className="text-label" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {ASSIGNABLE.map((r) => (
            <ListBox.Item key={r} id={r} textValue={t(`roles.${r}`)}>
              {t(`roles.${r}`)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function MembersPanel({ members }: { members: ReadonlyArray<Member> }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const { me, isAdmin } = usePermissions();
  const [removing, setRemoving] = useState<Member | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation(
    orpc.members.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(t("members.removed", { name: removing?.name || removing?.email || "" }));
        setRemoveOpen(false);
      },
    }),
  );
  const canManage = (m: Member) => isAdmin && m.role !== "owner" && m.id !== me?.id;
  const anyRemovable = members.some(canManage);
  return (
    <Panel>
      <PanelHeader title={t("members.title")} description={isAdmin ? t("members.descriptionAdmin") : t("members.description")} />
      <div className="overflow-x-auto">
        <table className={tbl.table}>
          <thead>
            <tr>
              <th className={tbl.th}>{t("members.name")}</th>
              <th className={`${tbl.th} hidden sm:table-cell`}>{t("members.email")}</th>
              <th className={tbl.th}>{t("members.role")}</th>
              <th className={`${tbl.th} hidden text-right md:table-cell`}>{t("members.joined")}</th>
              {anyRemovable && (
                <th className={tbl.th}>
                  <span className="sr-only">{t("members.actions")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={tbl.tr}>
                <td className={`${tbl.td} max-w-[260px]`}>
                  <span className="flex items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-default text-meta font-medium">
                      {(m.name || m.email).slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{m.name || m.email}</span>
                        {m.id === me?.id && <span className="text-meta text-muted">{t("members.you")}</span>}
                      </span>
                      <span className="block truncate text-meta text-muted sm:hidden">{m.email}</span>
                    </span>
                  </span>
                </td>
                <td className={`${tbl.td} hidden max-w-[280px] truncate text-muted sm:table-cell`}>{m.email}</td>
                <td className={`${tbl.td} whitespace-nowrap`}>
                  {canManage(m) ? <RoleSelect member={m} /> : <span className={m.role === "owner" ? "font-medium" : ""}>{t(`roles.${m.role}`)}</span>}
                </td>
                <td className={`${tbl.td} hidden whitespace-nowrap text-right text-muted tabular md:table-cell`}>
                  {formatJoined(new Date(m.createdAt))}
                </td>
                {anyRemovable && (
                  <td className={`${tbl.td} w-px text-right`}>
                    {canManage(m) && (
                      <Button size="sm" variant="ghost" className="h-8 text-muted" onPress={() => {
                          setRemoving(m);
                          remove.reset();
                          setRemoveOpen(true);
                        }}>
                        {t("members.remove")}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="grid gap-x-6 gap-y-1.5 border-t border-border px-5 py-4 text-label sm:grid-cols-[auto_1fr]">
        {ROLES.map((r) => (
          <div key={r} className="contents">
            <dt className="font-medium">{t(`roles.${r}`)}</dt>
            <dd className="text-muted">{t(`roles.${r}Help`)}</dd>
          </div>
        ))}
      </dl>
      <ConfirmDialog
        isOpen={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("members.removeTitle", { name: removing?.name || removing?.email || "" })}
        confirmLabel={t("members.removeConfirm")}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => removing !== null && remove.mutate({ id: removing.id })}
      >
        <p>
          <Trans
            t={t}
            i18nKey="members.removeBody"
            values={{ email: removing?.email ?? "" }}
            components={{ strong: <span className="text-foreground" /> }}
          />
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

function InvitationsPanel({ invitations }: { invitations: ReadonlyArray<Invitation> }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<Invitation | null>(null);
  const revoke = useMutation(
    orpc.members.revokeInvitation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        toast(t("invitations.revoked"), { description: t("invitations.revokedDescription") });
      },
      onError: (e) => toast.danger(t("invitations.revokeFailed"), { description: errorMessage(e) }),
    }),
  );
  return (
    <Panel>
      <PanelHeader title={t("invitations.title")} description={t("invitations.description")} />
      <InviteForm onCreated={setCreated} />
      {created !== null && <CreatedInvite invitation={created} onDismiss={() => setCreated(null)} />}
      {invitations.length === 0 ? (
        <p className="px-5 py-5 text-body text-muted">{t("invitations.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>{t("invitations.pending")}</th>
                <th className={tbl.th}>{t("members.role")}</th>
                <th className={`${tbl.th} hidden sm:table-cell`}>{t("invitations.expires")}</th>
                <th className={tbl.th}>
                  <span className="sr-only">{t("invitations.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => {
                const expired = new Date(inv.expiresAt).getTime() < Date.now();
                const relative = { relative: <RelativeTime date={inv.expiresAt} /> };
                return (
                  <tr key={inv.id} className={tbl.tr}>
                    <td className={`${tbl.td} max-w-[320px]`}>
                      <span className="block truncate">{inv.email}</span>
                      <span className="block text-meta text-muted sm:hidden">
                        <Trans t={t} i18nKey={expired ? "invitations.expiredAt" : "invitations.expiresAt"} components={relative} />
                      </span>
                    </td>
                    <td className={`${tbl.td} whitespace-nowrap`}>{t(`roles.${inv.role}`)}</td>
                    <td className={`${tbl.td} hidden text-muted sm:table-cell`}>
                      {expired ? (
                        <Trans t={t} i18nKey="invitations.expiredAt" components={relative} />
                      ) : (
                        <RelativeTime date={inv.expiresAt} />
                      )}
                    </td>
                    <td className={`${tbl.td} w-px whitespace-nowrap text-right`}>
                      <span className="inline-flex items-center gap-1">
                        {!expired && <CopyButton value={fullUrl(inv)} label={t("invite.copyLink")} />}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-muted"
                          isPending={revoke.isPending && revoke.variables?.id === inv.id}
                          onPress={() => revoke.mutate({ id: inv.id })}
                        >
                          {t("invitations.revoke")}
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function AboutPanel() {
  const { t } = useTranslation("settings");
  const links = [
    { href: REPO, label: t("about.docs") },
    { href: `${REPO}/tree/main/packages/sdk`, label: t("about.sdkReference") },
    { href: `${REPO}/issues`, label: t("about.reportIssue") },
  ];
  return (
    <Panel>
      <PanelHeader title={t("about.title")} />
      <div className="flex flex-col gap-4 px-5 py-4 text-body">
        <p className="max-w-[72ch] text-muted">
          <Trans t={t} i18nKey="about.dataLocation" components={{ code: <code className="font-mono text-foreground" /> }} />
        </p>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-1 text-label">
          <dt className="text-muted">{t("about.sdkHost")}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{window.location.origin}</code>
            <CopyButton value={window.location.origin} label={t("about.copySdkHost")} />
          </dd>
        </dl>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-label">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              >
                {l.label}
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function Page() {
  const { t } = useTranslation("settings");
  const { isAdmin } = usePermissions();
  const list = useQuery(orpc.members.list.queryOptions());
  return (
    <>
      <PageHeader title={t("page.title")} description={t("page.description")} />
      <div className="flex flex-col gap-6">
        {list.isPending ? (
          <Panel>
            <ListSkeleton rows={3} />
          </Panel>
        ) : list.isError ? (
          <QueryError message={t("page.loadFailed", { message: errorMessage(list.error) })} onRetry={() => list.refetch()} />
        ) : (
          <>
            <MembersPanel members={list.data.members} />
            {isAdmin && <InvitationsPanel invitations={list.data.invitations} />}
          </>
        )}
        {/* Admin-only on the server; nothing useful to show anyone else */}
        {isAdmin && <ApiKeysPanel />}
        {isAdmin && <WebhooksPanel />}
        <AboutPanel />
      </div>
    </>
  );
}
