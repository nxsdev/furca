import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { makeDrizzle } from "@furca/database/Database";
import * as schema from "@furca/database/schema/index";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { and, count, eq, isNull } from "drizzle-orm";
import type { FurcaEnv } from "./Env";

const { user, session, account, verification, invitations } = schema;

/** Header the invite page sends with sign-up: the one-time token from the invitation link */
export const INVITATION_HEADER = "x-furca-invitation";

/** `code` lets the sign-up screens show it in the user's language */
const inviteOnly = () =>
  new APIError("FORBIDDEN", { code: "INVITE_ONLY", message: "Sign-up is invite-only. Ask a member for an invitation link." });

/**
 * Email + password auth. The first account becomes the owner; after that sign-up requires the
 * one-time token of a pending, unexpired invitation (created in Settings > Members) for the same
 * email, and the account gets the invitation's role
 */
export const createAuth = (env: FurcaEnv, origin: string) => {
  const db = makeDrizzle(env.DB);
  const tokenOf = (ctx: { readonly headers?: Headers | undefined } | null) => ctx?.headers?.get(INVITATION_HEADER) ?? "";
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL ?? origin,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: { user, session, account, verification } }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Never accepted from the sign-up body; set by the hook below and members.setRole
    user: { additionalFields: { role: { type: "string", input: false, defaultValue: "viewer" } } },
    databaseHooks: {
      user: {
        create: {
          // ponytail: count-then-insert race on the very first sign-up; acceptable for a one-time bootstrap
          before: async (candidate, ctx) => {
            const [row] = await db.select({ n: count() }).from(user);
            if ((row?.n ?? 0) === 0) return { data: { ...candidate, role: "owner" } };
            const token = tokenOf(ctx);
            // Looked up by the unique token index, so the secret is never compared byte by byte in JS
            const invite =
              token === ""
                ? undefined
                : await db.query.invitations.findFirst({ where: { token, acceptedAt: { isNull: true }, expiresAt: { gt: new Date() } } });
            if (invite === undefined || invite.email !== candidate.email.toLowerCase()) throw inviteOnly();
            return { data: { ...candidate, role: invite.role } };
          },
          after: async (_created, ctx) => {
            const token = tokenOf(ctx);
            if (token !== "") await db.update(invitations).set({ acceptedAt: new Date() }).where(and(eq(invitations.token, token), isNull(invitations.acceptedAt)));
          },
        },
      },
    },
  });
};

export type Auth = ReturnType<typeof createAuth>;
