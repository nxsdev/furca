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
  if (code === "INVALID_EMAIL_OR_PASSWORD") return i18n.t(($) => $.auth.errors.invalidCredentials, { ns: "shell" });
  if (code.startsWith("USER_ALREADY_EXISTS")) return i18n.t(($) => $.auth.errors.userExists, { ns: "shell" });
  if (code === "PASSWORD_TOO_SHORT") return i18n.t(($) => $.auth.errors.passwordTooShort, { ns: "shell" });
  if (code === "INVITE_ONLY") return i18n.t(($) => $.auth.errors.inviteOnly, { ns: "shell" });
  return error.message ?? i18n.t(($) => $.auth.errors[fallback], { ns: "shell" });
};
