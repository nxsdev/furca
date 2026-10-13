import { Database } from "@kuji/database/Database";
import { user } from "@kuji/database/schema/index";
import { ORPCError } from "@orpc/server";
import { count } from "drizzle-orm";
import { Effect } from "effect";
import { pub } from "../Runtime/orpc";

export const publicRouter = {
  setupStatus: pub.public.setupStatus.effect(function* () {
    const database = yield* Database;
    const rows = yield* database.run("user.count", (db) => db.select({ n: count() }).from(user));
    return { needsSetup: (rows[0]?.n ?? 0) === 0 };
  }),

  invitation: pub.public.invitation.effect(function* (_opts, { token }) {
    const database = yield* Database;
    const invite = yield* database.run("invitations.byToken", (db) =>
      db.query.invitations.findFirst({
        where: { token, acceptedAt: { isNull: true }, expiresAt: { gt: new Date() } },
      }),
    );
    if (invite === undefined) {
      return yield* Effect.fail(new ORPCError("NOT_FOUND", { message: "This invitation is invalid or has expired" }));
    }
    return { email: invite.email };
  }),
};
