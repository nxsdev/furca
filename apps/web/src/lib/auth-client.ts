import { createAuthClient } from "better-auth/react";
import { i18n } from "~/i18n";

/** Same-origin Better Auth client (/api/auth/*) */
export const authClient = createAuthClient();

/** Better Auth error -> message in the current language, falling back to the server's text */
export const authErrorMessage = (
  error: { readonly code?: string | undefined; readonly message?: string | undefined },
  fallback: "createFailed" | "invalidCredentials",
): string => {
  const code = error.code ?? "";
  if (code === "INVALID_EMAIL_OR_PASSWORD") return i18n.t("shell:auth.errors.invalidCredentials");
  if (code.startsWith("USER_ALREADY_EXISTS")) return i18n.t("shell:auth.errors.userExists");
  if (code === "PASSWORD_TOO_SHORT") return i18n.t("shell:auth.errors.passwordTooShort");
  if (error.message?.includes("invite-only")) return i18n.t("shell:auth.errors.inviteOnly");
  return error.message ?? i18n.t(`shell:auth.errors.${fallback}`);
};
