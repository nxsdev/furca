import { AssignableRole } from "@furca/core/members/Member";
import { issue } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { user } from "@furca/database/schema/index";
import { count } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { orpcError, pub } from "../Runtime/orpc";

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
      return yield* Effect.fail(orpcError("NOT_FOUND", issue("invitation.invalid")));
    }
    return { email: invite.email, role: Schema.decodeUnknownSync(AssignableRole)(invite.role) };
  }),
};
