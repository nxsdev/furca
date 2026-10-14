import { Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthCard } from "~/components/shell/AuthCard";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";
import { authClient, authErrorMessage } from "~/lib/auth-client";
import { orpc } from "~/lib/rpc";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () => ({ meta: [{ title: i18n.t("shell:auth.signIn.pageTitle") }] }),
  component: LoginPage,
});

function LoginPage() {
  const { t } = useTranslation("shell");
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
        title={t("auth.setup.title")}
        description={t("auth.setup.description")}
        submitLabel={t("auth.setup.submit")}
        fields={[
          { name: "name", label: t("auth.fields.name"), autoComplete: "name" },
          { name: "email", label: t("auth.fields.email"), type: "email", autoComplete: "email" },
          {
            name: "password",
            label: t("auth.fields.password"),
            type: "password",
            autoComplete: "new-password",
            minLength: 10,
            description: t("auth.fields.passwordHint", { count: 10 }),
          },
        ]}
        onSubmit={async ({ name, email, password }) => {
          const { error } = await authClient.signUp.email({ name, email, password });
          return error ? authErrorMessage(error, "createFailed") : done();
        }}
      />
    );
  }

  return (
    <AuthCard
      title={t("auth.signIn.title")}
      description={t("auth.signIn.description")}
      submitLabel={t("auth.signIn.submit")}
      fields={[
        { name: "email", label: t("auth.fields.email"), type: "email", autoComplete: "email" },
        { name: "password", label: t("auth.fields.password"), type: "password", autoComplete: "current-password" },
      ]}
      onSubmit={async ({ email, password }) => {
        const { error } = await authClient.signIn.email({ email, password });
        return error ? authErrorMessage(error, "invalidCredentials") : done();
      }}
      footer={t("auth.signIn.footer")}
    />
  );
}
