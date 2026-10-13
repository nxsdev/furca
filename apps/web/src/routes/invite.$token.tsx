import { Link, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthCard } from "~/components/shell/AuthCard";
import { authClient } from "~/lib/auth-client";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/invite/$token")({
  ssr: false,
  head: () => ({ meta: [{ title: "Join · kuji" }] }),
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const invitation = useQuery({ ...orpc.public.invitation.queryOptions({ input: { token } }), retry: false });

  if (invitation.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner size="sm" color="current" />
      </div>
    );
  }
  if (invitation.error !== null) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
        <h1 className="text-title font-semibold">Invitation unavailable</h1>
        <p className="text-body text-muted">{errorMessage(invitation.error)}. Ask for a new link.</p>
        <Link href="/login">Go to sign in</Link>
      </div>
    );
  }

  return (
    <AuthCard
      title="Join kuji"
      description={`You were invited as ${invitation.data.email}.`}
      submitLabel="Create account"
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "email", defaultValue: invitation.data.email, isReadOnly: true },
        { name: "name", label: "Name", autoComplete: "name" },
        { name: "password", label: "Password", type: "password", autoComplete: "new-password", minLength: 10 },
      ]}
      onSubmit={async ({ name, email, password }) => {
        const { error } = await authClient.signUp.email({ name, email, password });
        if (error) return error.message ?? "Could not create the account";
        await navigate({ to: "/overview" });
        return null;
      }}
    />
  );
}
