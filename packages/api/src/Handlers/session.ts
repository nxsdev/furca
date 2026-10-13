import { Database } from "@furca/database/Database";
import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { authed } from "../Runtime/orpc";

export const sessionRouter = {
  me: authed.session.me.effect(function* ({ context }) {
    const database = yield* Database;
    const row = yield* database.run("user.get", (db) => db.query.user.findFirst({ where: { id: context.user.id } }));
    if (row === undefined) return yield* Effect.fail(new ORPCError("UNAUTHORIZED", { message: "Sign in required" }));
    return { id: row.id, email: row.email, name: row.name, isOwner: context.user.isOwner, createdAt: row.createdAt };
  }),
};
