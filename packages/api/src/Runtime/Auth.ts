import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { makeDrizzle } from "@furca/database/Database";
import * as schema from "@furca/database/schema/index";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import type { FurcaEnv } from "./Env";

const { user, session, account, verification, invitations } = schema;

/**
 * Email + password auth. The first account becomes the owner; after that sign-up requires an
 * unexpired invitation for the same email (created in Settings > Members)
 */
export const createAuth = (env: FurcaEnv, origin: string) => {
  const db = makeDrizzle(env.DB);
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL ?? origin,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema: { user, session, account, verification } }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    databaseHooks: {
      user: {
        create: {
          // ponytail: count-then-insert race on the very first sign-up; acceptable for a one-time bootstrap
          before: async (candidate) => {
            const [row] = await db.select({ n: count() }).from(user);
            if ((row?.n ?? 0) === 0) return;
            const invite = await db.query.invitations.findFirst({
              where: { email: candidate.email.toLowerCase(), acceptedAt: { isNull: true }, expiresAt: { gt: new Date() } },
            });
            if (invite === undefined) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is invite-only. Ask a member for an invitation link." });
            }
          },
          after: async (created) => {
            await db
              .update(invitations)
              .set({ acceptedAt: new Date() })
              .where(and(eq(invitations.email, created.email.toLowerCase()), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())));
          },
        },
      },
    },
  });
};

export type Auth = ReturnType<typeof createAuth>;
