import { Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthCard } from "~/components/shell/AuthCard";
import { authClient } from "~/lib/auth-client";
import { orpc } from "~/lib/rpc";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () => ({ meta: [{ title: "Sign in · furca" }] }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const status = useQuery(orpc.public.setupStatus.queryOptions());
  const done = async () => {
    await navigate({ to: "/overview" });
    return null;
  };

  if (status.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner size="sm" color="current" />
      </div>
    );
  }

  if (status.data?.needsSetup === true) {
    return (
      <AuthCard
        title="Set up furca"
        description="Create the owner account. Everyone else joins by invitation."
        submitLabel="Create owner account"
        fields={[
          { name: "name", label: "Name", autoComplete: "name" },
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          { name: "password", label: "Password", type: "password", autoComplete: "new-password", minLength: 10 },
        ]}
        onSubmit={async ({ name, email, password }) => {
          const { error } = await authClient.signUp.email({ name, email, password });
          return error ? (error.message ?? "Could not create the account") : done();
        }}
      />
    );
  }

  return (
    <AuthCard
      title="Sign in to furca"
      description="Feature flags and experiments you can trust."
      submitLabel="Sign in"
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "email" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]}
      onSubmit={async ({ email, password }) => {
        const { error } = await authClient.signIn.email({ email, password });
        return error ? (error.message ?? "Email or password is incorrect") : done();
      }}
      footer="No account? Ask a teammate for an invitation link."
    />
  );
}
