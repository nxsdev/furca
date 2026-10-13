import { Button, Input, Label, TextField, toast } from "@heroui/react";
import type { Invitation, Member } from "@kuji/core/members/Member";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Link2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { CopyButton, ListSkeleton, PageHeader, Panel, PanelHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings · kuji" }] }),
  component: Page,
});

const REPO = "https://github.com/nxsdev/kuji";
const fullUrl = (inv: Invitation) => new URL(inv.url, window.location.origin).toString();
const joinedFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function InviteForm({ onCreated }: { onCreated: (inv: Invitation) => void }) {
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
          <Label>Invite by email</Label>
          <Input placeholder="teammate@company.com" />
        </TextField>
        <Button type="submit" size="sm" isPending={invite.isPending} isDisabled={!valid} className="h-9">
          <Link2 className="size-4" />
          Create invite link
        </Button>
      </div>
      {invite.error !== null && (
        <p role="alert" className="text-label text-danger">
          {errorMessage(invite.error)}
        </p>
      )}
      <p className="text-xs text-muted">No email is sent. You get a one-time sign-up link to share; it works for 7 days.</p>
    </form>
  );
}

function CreatedInvite({ invitation, onDismiss }: { invitation: Invitation; onDismiss: () => void }) {
  const url = fullUrl(invitation);
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-default/30 px-5 py-4" role="status">
      <p className="text-label">
        Invite link for <span className="font-medium">{invitation.email}</span>. Send it to them directly; it can be used once.
      </p>
      <div className="flex items-center gap-1 rounded-md border border-border bg-background py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-label">{url}</code>
        <CopyButton value={url} label="Copy invite link" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Expires <RelativeTime date={invitation.expiresAt} />.
        </p>
        <Button size="sm" variant="ghost" onPress={onDismiss} className="h-7">
          Done
        </Button>
      </div>
    </div>
  );
}

function MembersPanel({ me, members }: { me: Member | undefined; members: ReadonlyArray<Member> }) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<Member | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation(
    orpc.members.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
        toast(`${removing?.name || removing?.email} removed`);
        setRemoveOpen(false);
      },
    }),
  );
  const canRemove = (m: Member) => me?.isOwner === true && !m.isOwner && m.id !== me.id;
  const anyRemovable = members.some(canRemove);
  return (
    <Panel>
      <PanelHeader
        title="Members"
        description={
          me?.isOwner === true
            ? "Everyone here can edit flags, experiments and metrics. Only you, the owner, can remove members."
            : "Everyone here can edit flags, experiments and metrics. Only the owner can remove members."
        }
      />
      <div className="overflow-x-auto">
        <table className={tbl.table}>
          <thead>
            <tr>
              <th className={tbl.th}>Name</th>
              <th className={`${tbl.th} hidden sm:table-cell`}>Email</th>
              <th className={`${tbl.th} hidden text-right md:table-cell`}>Joined</th>
              {anyRemovable && (
                <th className={tbl.th}>
                  <span className="sr-only">Actions</span>
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
                          <span className="rounded-[5px] border border-border px-1.5 text-meta font-medium text-muted">Owner</span>
                        )}
                        {m.id === me?.id && <span className="text-meta text-muted">You</span>}
                      </span>
                      <span className="block truncate text-meta text-muted sm:hidden">{m.email}</span>
                    </span>
                  </span>
                </td>
                <td className={`${tbl.td} hidden max-w-[280px] truncate text-muted sm:table-cell`}>{m.email}</td>
                <td className={`${tbl.td} hidden whitespace-nowrap text-right text-muted tabular md:table-cell`}>
                  {joinedFormat.format(new Date(m.createdAt))}
                </td>
                {anyRemovable && (
                  <td className={`${tbl.td} w-px text-right`}>
                    {canRemove(m) && (
                      <Button size="sm" variant="ghost" className="h-8 text-muted" onPress={() => {
                          setRemoving(m);
                          remove.reset();
                          setRemoveOpen(true);
                        }}>
                        Remove
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
        title={`Remove ${removing?.name || removing?.email || ""}?`}
        confirmLabel="Remove member"
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
        onConfirm={() => removing !== null && remove.mutate({ id: removing.id })}
      >
        <p>
          <span className="text-foreground">{removing?.email}</span> loses access immediately. Their past changes stay in the
          audit log. To bring them back, send a new invitation.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

function InvitationsPanel({ invitations }: { invitations: ReadonlyArray<Invitation> }) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<Invitation | null>(null);
  const revoke = useMutation(
    orpc.members.revokeInvitation.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.members.key() });
        toast("Invitation revoked", { description: "The link no longer works." });
      },
      onError: (e) => toast.danger("Couldn't revoke the invitation", { description: errorMessage(e) }),
    }),
  );
  const pending = invitations.filter((i) => i.id !== created?.id);
  return (
    <Panel>
      <PanelHeader title="Invitations" description="kuji is invite-only: people join through a link you create here." />
      <InviteForm onCreated={setCreated} />
      {created !== null && <CreatedInvite invitation={created} onDismiss={() => setCreated(null)} />}
      {pending.length === 0 ? (
        <p className="px-5 py-5 text-body text-muted">No pending invitations.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>Pending</th>
                <th className={`${tbl.th} hidden sm:table-cell`}>Expires</th>
                <th className={tbl.th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pending.map((inv) => {
                const expired = new Date(inv.expiresAt).getTime() < Date.now();
                return (
                  <tr key={inv.id} className={tbl.tr}>
                    <td className={`${tbl.td} max-w-[320px]`}>
                      <span className="block truncate">{inv.email}</span>
                      <span className="block text-meta text-muted sm:hidden">
                        {expired ? "Expired " : "Expires "}
                        <RelativeTime date={inv.expiresAt} />
                      </span>
                    </td>
                    <td className={`${tbl.td} hidden text-muted sm:table-cell`}>
                      {expired ? "Expired " : ""}
                      <RelativeTime date={inv.expiresAt} />
                    </td>
                    <td className={`${tbl.td} w-px whitespace-nowrap text-right`}>
                      <span className="inline-flex items-center gap-1">
                        {!expired && <CopyButton value={fullUrl(inv)} label="Copy invite link" />}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-muted"
                          isPending={revoke.isPending && revoke.variables?.id === inv.id}
                          onPress={() => revoke.mutate({ id: inv.id })}
                        >
                          Revoke
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
  const links = [
    { href: REPO, label: "Documentation" },
    { href: `${REPO}/tree/main/packages/sdk`, label: "SDK reference" },
    { href: `${REPO}/issues`, label: "Report an issue" },
  ];
  return (
    <Panel>
      <PanelHeader title="About this instance" />
      <div className="flex flex-col gap-4 px-5 py-4 text-body">
        <p className="max-w-[72ch] text-muted">
          Your data stays in your Cloudflare account. Flags, experiments, exposures and events live in this deployment's D1
          database and KV namespace; BigQuery keys are encrypted at rest with its <code className="font-mono text-foreground">ENCRYPTION_KEY</code>.
        </p>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-1 text-label">
          <dt className="text-muted">SDK host</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{window.location.origin}</code>
            <CopyButton value={window.location.origin} label="Copy SDK host" />
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
  const me = useQuery(orpc.session.me.queryOptions());
  const list = useQuery(orpc.members.list.queryOptions());
  return (
    <>
      <PageHeader title="Settings" description="Who has access to this kuji instance, and where its data lives." />
      <div className="flex flex-col gap-6">
        {list.isPending ? (
          <Panel>
            <ListSkeleton rows={3} />
          </Panel>
        ) : list.isError ? (
          <QueryError message={`Couldn't load members. ${errorMessage(list.error)}`} onRetry={() => list.refetch()} />
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
