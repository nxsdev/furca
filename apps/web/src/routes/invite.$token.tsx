import { Link, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthCard } from "~/components/shell/AuthCard";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";
import { authClient, authErrorMessage } from "~/lib/auth-client";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/invite/$token")({
  ssr: false,
  head: () => ({ meta: [{ title: i18n.t("shell:auth.invite.pageTitle") }] }),
  component: InvitePage,
});

function InvitePage() {
  const { t } = useTranslation("shell");
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
        <h1 className="text-title font-semibold">{t("auth.invite.unavailable")}</h1>
        <p className="text-body text-muted">{t("auth.invite.unavailableBody", { reason: errorMessage(invitation.error) })}</p>
        <Link href="/login">{t("auth.invite.goToSignIn")}</Link>
      </div>
    );
  }

  return (
    <AuthCard
      title={t("auth.invite.title")}
      description={t("auth.invite.description", { email: invitation.data.email })}
      submitLabel={t("auth.invite.submit")}
      fields={[
        { name: "email", label: t("auth.fields.email"), type: "email", autoComplete: "email", defaultValue: invitation.data.email, isReadOnly: true },
        { name: "name", label: t("auth.fields.name"), autoComplete: "name" },
        { name: "password", label: t("auth.fields.password"), type: "password", autoComplete: "new-password", minLength: 10 },
      ]}
      onSubmit={async ({ name, email, password }) => {
        // The server accepts the sign-up only with this invitation's one-time token (INVITATION_HEADER in Auth.ts)
        const { error } = await authClient.signUp.email({ name, email, password, fetchOptions: { headers: { "x-furca-invitation": token } } });
        if (error) return authErrorMessage(error, "createFailed");
        await navigate({ to: "/overview" });
        return null;
      }}
    />
  );
}
