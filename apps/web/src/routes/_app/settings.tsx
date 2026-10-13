import { Button, Input, Label, TextField, toast } from "@heroui/react";
import type { Invitation, Member } from "@furca/core/members/Member";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Link2 } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { CopyButton, ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n, intlLocale } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: i18n.t("settings:pageTitle") }] }),
  component: Page,
});

const REPO = "https://github.com/nxsdev/furca";
const fullUrl = (inv: Invitation) => new URL(inv.url, window.location.origin).toString();
const formatJoined = (d: Date) => d.toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" });

function InviteForm({ onCreated }: { onCreated: (inv: Invitation) => void }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const invite = useMutation(
    orpc.members.invite.mutationOptions({
      onSuccess: (inv) => {
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        setEmail("");
        onCreated(inv);
      },
    }),
  );
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <form
      className="flex flex-col gap-2 border-b border-border px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) invite.mutate({ email: email.trim() });
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <TextField value={email} onChange={setEmail} type="email" className="sm:w-80" autoComplete="off">
          <Label>{t("invite.label")}</Label>
          <Input placeholder="teammate@company.com" />
        </TextField>
        <Button type="submit" size="sm" isPending={invite.isPending} isDisabled={!valid} className="h-9">
          <Link2 className="size-4" />
          {t("invite.submit")}
        </Button>
      </div>
      {invite.error !== null && (
        <p role="alert" className="text-label text-danger">
          {errorMessage(invite.error)}
        </p>
      )}
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

function MembersPanel({ me, members }: { me: Member | undefined; members: ReadonlyArray<Member> }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
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
  const canRemove = (m: Member) => me?.isOwner === true && !m.isOwner && m.id !== me.id;
  const anyRemovable = members.some(canRemove);
  return (
    <Panel>
      <PanelHeader
        title={t("members.title")}
        description={me?.isOwner === true ? t("members.descriptionOwner") : t("members.description")}
      />
      <div className="overflow-x-auto">
        <table className={tbl.table}>
          <thead>
            <tr>
              <th className={tbl.th}>{t("members.name")}</th>
              <th className={`${tbl.th} hidden sm:table-cell`}>{t("members.email")}</th>
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
                        {m.isOwner && (
                          <span className="rounded-[5px] border border-border px-1.5 text-meta font-medium text-muted">{t("members.owner")}</span>
                        )}
                        {m.id === me?.id && <span className="text-meta text-muted">{t("members.you")}</span>}
                      </span>
                      <span className="block truncate text-meta text-muted sm:hidden">{m.email}</span>
                    </span>
                  </span>
                </td>
                <td className={`${tbl.td} hidden max-w-[280px] truncate text-muted sm:table-cell`}>{m.email}</td>
                <td className={`${tbl.td} hidden whitespace-nowrap text-right text-muted tabular md:table-cell`}>
                  {formatJoined(new Date(m.createdAt))}
                </td>
                {anyRemovable && (
                  <td className={`${tbl.td} w-px text-right`}>
                    {canRemove(m) && (
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
  const pending = invitations.filter((i) => i.id !== created?.id);
  return (
    <Panel>
      <PanelHeader title={t("invitations.title")} description={t("invitations.description")} />
      <InviteForm onCreated={setCreated} />
      {created !== null && <CreatedInvite invitation={created} onDismiss={() => setCreated(null)} />}
      {pending.length === 0 ? (
        <p className="px-5 py-5 text-body text-muted">{t("invitations.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>{t("invitations.pending")}</th>
                <th className={`${tbl.th} hidden sm:table-cell`}>{t("invitations.expires")}</th>
                <th className={tbl.th}>
                  <span className="sr-only">{t("invitations.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pending.map((inv) => {
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
  const me = useQuery(orpc.session.me.queryOptions());
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
            <MembersPanel me={me.data} members={list.data.members} />
            <InvitationsPanel invitations={list.data.invitations} />
          </>
        )}
        <AboutPanel />
      </div>
    </>
  );
}
