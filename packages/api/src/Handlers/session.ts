import { issue } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { Effect } from "effect";
import { authed, orpcError } from "../Runtime/orpc";

export const sessionRouter = {
  me: authed.session.me.effect(function* ({ context }) {
    const database = yield* Database;
    const row = yield* database.run("user.get", (db) => db.query.user.findFirst({ where: { id: context.user.id } }));
    if (row === undefined) return yield* Effect.fail(orpcError("UNAUTHORIZED", issue("auth.signInRequired")));
    return { id: row.id, email: row.email, name: row.name, role: context.user.role, createdAt: row.createdAt };
  }),
};
