import type { Actor } from "@furca/core/audit/AuditLog";
import { Namespace } from "@furca/core/experiments/Namespace";
import { NamespaceService } from "@furca/core/experiments/NamespaceService";
import { ConflictError, issue, NotFoundError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { namespaces } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { toExperiment, toNamespace } from "../mappers";
import { auditInsert, batch, invalid, newId } from "../shared";

export const NamespaceServiceLive = Layer.effect(
  NamespaceService,
  Effect.gen(function* () {
    const database = yield* Database;

    const load = (id: string) =>
      database
        .run("namespaces.get", (db) => db.query.namespaces.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) => (row ? Effect.succeed(toNamespace(row)) : Effect.fail(new NotFoundError({ entity: "namespace", id })))),
        );

    /** Draft and running experiments holding a slice of any namespace (archived drafts are left out) */
    const holders = database
      .run("experiments.active", (db) =>
        db.query.experiments.findMany({ where: { status: { in: ["draft", "running"] }, archivedAt: { isNull: true }, namespace: { isNotNull: true } } }),
      )
      .pipe(Effect.map((rows) => rows.map(toExperiment)));

    const write = (action: string, actor: Actor, before: Namespace | null, after: Namespace) =>
      database.run(`namespaces.${action}`, (db) =>
        batch(db, [
          before === null
            ? db.insert(namespaces).values({ ...after })
            : db
                .update(namespaces)
                .set({ name: after.name, description: after.description, updatedAt: after.updatedAt })
                .where(eq(namespaces.id, after.id)),
          auditInsert(db, { entityType: "namespace", entityId: after.id, action, actor, before, after }),
        ]),
      );

    const requireName = (name: string) => (name.trim() === "" ? invalid("common.nameRequired", undefined, "name") : Effect.void);

    return {
      list: Effect.gen(function* () {
        const rows = yield* database.run("namespaces.list", (db) => db.query.namespaces.findMany({ orderBy: { name: "asc" } }));
        const experiments = yield* holders;
        return rows.map((row) => ({
          namespace: toNamespace(row),
          allocations: experiments
            .flatMap((e) =>
              e.namespace?.namespaceId === row.id
                ? [{ experimentId: e.id, experimentName: e.name, status: e.status, start: e.namespace.start, end: e.namespace.end }]
                : [],
            )
            .sort((a, b) => a.start - b.start),
        }));
      }).pipe(Effect.withSpan("NamespaceService.list")),

      create: Effect.fn("NamespaceService.create")(function* (input, actor) {
        yield* requireName(input.name);
        const existing = yield* database.run("namespaces.byKey", (db) => db.query.namespaces.findFirst({ where: { key: input.key } }));
        if (existing !== undefined) return yield* invalid("namespace.keyTaken", { key: input.key }, "key");
        const now = new Date();
        const namespace = Namespace.make({
          id: newId(),
          key: input.key,
          name: input.name.trim(),
          description: input.description.trim(),
          createdAt: now,
          updatedAt: now,
        });
        yield* write("created", actor, null, namespace);
        return namespace;
      }),

      // The key is what SDKs hash and it never changes, so payloads stay as they are
      update: Effect.fn("NamespaceService.update")(function* (input, actor) {
        yield* requireName(input.name);
        const before = yield* load(input.id);
        const after = Namespace.make({ ...before, name: input.name.trim(), description: input.description.trim(), updatedAt: new Date() });
        yield* write("updated", actor, before, after);
        return after;
      }),

      delete: Effect.fn("NamespaceService.delete")(function* (id, actor) {
        const before = yield* load(id);
        const holder = (yield* holders).find((e) => e.namespace?.namespaceId === id);
        if (holder !== undefined) {
          return yield* new ConflictError(
            issue(holder.status === "running" ? "namespace.heldByRunning" : "namespace.heldByDraft", { experiment: holder.name }),
          );
        }
        yield* database.run("namespaces.delete", (db) =>
          batch(db, [
            db.delete(namespaces).where(eq(namespaces.id, id)),
            auditInsert(db, { entityType: "namespace", entityId: id, action: "deleted", actor, before, after: null }),
          ]),
        );
      }),
    };
  }),
);
