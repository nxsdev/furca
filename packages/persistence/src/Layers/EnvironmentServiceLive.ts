import { Environment } from "@furca/core/environments/Environment";
import { EnvironmentService } from "@furca/core/environments/EnvironmentService";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import { ConflictError, NotFoundError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { environments, experiments, featureEnvironments, features } from "@furca/database/schema/index";
import { and, count, eq, isNull, max, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { toEnvironment, toExperiment } from "../mappers";
import { buildPayloads, publishAll } from "../payload";
import { auditInsert, batch, invalid, newId, randomHex } from "../shared";

export const newSdkKey = () => `sdk-${randomHex(12)}`;

export const EnvironmentServiceLive = Layer.effect(
  EnvironmentService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;

    const load = (id: string) =>
      database
        .run("environments.get", (db) => db.query.environments.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) =>
            row ? Effect.succeed(toEnvironment(row)) : Effect.fail(new NotFoundError({ entity: "environment", id })),
          ),
        );

    const requireName = (name: string) => (name.trim() === "" ? invalid("Name is required") : Effect.void);

    return {
      list: Effect.gen(function* () {
        const rows = yield* database.run("environments.list", (db) =>
          db.query.environments.findMany({ orderBy: { sortOrder: "asc" } }),
        );
        const counts = yield* database.run("environments.featureCounts", (db) =>
          db
            .select({ environmentId: featureEnvironments.environmentId, n: count() })
            .from(featureEnvironments)
            .innerJoin(features, eq(features.id, featureEnvironments.featureId))
            .where(and(eq(featureEnvironments.enabled, true), isNull(features.archivedAt)))
            .groupBy(featureEnvironments.environmentId),
        );
        return yield* Effect.forEach(
          rows,
          (row) =>
            store.get(row.sdkKey).pipe(
              Effect.map((json) => ({
                environment: toEnvironment(row),
                payloadBytes: json === null ? null : new TextEncoder().encode(json).byteLength,
                featureCount: counts.find((c) => c.environmentId === row.id)?.n ?? 0,
              })),
            ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.withSpan("EnvironmentService.list")),

      create: Effect.fn("EnvironmentService.create")(function* (input, actor) {
        yield* requireName(input.name);
        const existing = yield* database.run("environments.byKey", (db) =>
          db.query.environments.findFirst({ where: { key: input.key } }),
        );
        if (existing !== undefined) return yield* invalid(`An environment with key "${input.key}" already exists`);
        const [last] = yield* database.run("environments.maxSort", (db) =>
          db.select({ sortOrder: max(environments.sortOrder) }).from(environments),
        );
        const environment = Environment.make({
          id: newId(),
          key: input.key,
          name: input.name.trim(),
          sdkKey: newSdkKey(),
          sortOrder: (last?.sortOrder ?? -1) + 1,
          requireApproval: false,
          createdAt: new Date(),
        });
        yield* database.run("environments.create", (db) =>
          batch(db, [
            db.insert(environments).values({ ...environment }),
            db
              .insert(featureEnvironments)
              .select(
                db
                  .select({
                    featureId: features.id,
                    environmentId: sql<string>`${environment.id}`.as("environment_id"),
                    enabled: sql<boolean>`0`.as("enabled"),
                    rules: sql<unknown>`'[]'`.as("rules"),
                  })
                  .from(features),
              ),
            auditInsert(db, { entityType: "environment", entityId: environment.id, action: "created", actor, before: null, after: environment }),
          ]),
        );
        yield* publishAll(database, store);
        return environment;
      }),

      update: Effect.fn("EnvironmentService.update")(function* (input, actor) {
        const before = yield* load(input.id);
        yield* requireName(input.name);
        const after = Environment.make({ ...before, name: input.name.trim() });
        yield* database.run("environments.update", (db) =>
          batch(db, [
            db.update(environments).set({ name: after.name }).where(eq(environments.id, after.id)),
            auditInsert(db, { entityType: "environment", entityId: after.id, action: "updated", actor, before, after }),
          ]),
        );
        return after;
      }),

      // SDK payloads do not change: no republish
      setRequireApproval: Effect.fn("EnvironmentService.setRequireApproval")(function* (input, actor) {
        const before = yield* load(input.id);
        if (before.requireApproval === input.requireApproval) return before;
        const after = Environment.make({ ...before, requireApproval: input.requireApproval });
        yield* database.run("environments.setRequireApproval", (db) =>
          batch(db, [
            db.update(environments).set({ requireApproval: after.requireApproval }).where(eq(environments.id, after.id)),
            auditInsert(db, {
              entityType: "environment",
              entityId: after.id,
              action: after.requireApproval ? "review.required" : "review.notRequired",
              actor,
              before,
              after,
            }),
          ]),
        );
        return after;
      }),

      rotateSdkKey: Effect.fn("EnvironmentService.rotateSdkKey")(function* (id, actor) {
        const before = yield* load(id);
        const after = Environment.make({ ...before, sdkKey: newSdkKey() });
        yield* database.run("environments.rotateSdkKey", (db) =>
          batch(db, [
            db.update(environments).set({ sdkKey: after.sdkKey }).where(eq(environments.id, id)),
            auditInsert(db, { entityType: "environment", entityId: id, action: "sdkKey.rotated", actor, before, after }),
          ]),
        );
        yield* publishAll(database, store);
        yield* store.remove(before.sdkKey);
        return after;
      }),

      delete: Effect.fn("EnvironmentService.delete")(function* (id, actor) {
        const before = yield* load(id);
        const [total] = yield* database.run("environments.count", (db) => db.select({ n: count() }).from(environments));
        if ((total?.n ?? 0) <= 1) return yield* new ConflictError({ message: "The last environment cannot be deleted" });
        const rows = yield* database.run("experiments.notStopped", (db) =>
          db.query.experiments.findMany({ where: { status: { in: ["draft", "running"] } } }),
        );
        const using = rows.map(toExperiment).filter((e) => e.environmentIds.includes(id) || e.analysisEnvironmentId === id);
        const running = using.find((e) => e.status === "running");
        if (running !== undefined) {
          return yield* new ConflictError({ message: `The experiment "${running.name}" is running in this environment. Stop it first` });
        }
        yield* database.run("environments.delete", (db) =>
          batch(db, [
            db.delete(featureEnvironments).where(eq(featureEnvironments.environmentId, id)),
            // Drafts drop the environment so they stay editable
            ...using.map((e) =>
              db
                .update(experiments)
                .set({ environmentIds: e.environmentIds.filter((x) => x !== id) })
                .where(eq(experiments.id, e.id)),
            ),
            db.delete(environments).where(eq(environments.id, id)),
            auditInsert(db, { entityType: "environment", entityId: id, action: "deleted", actor, before, after: null }),
          ]),
        );
        yield* store.remove(before.sdkKey);
      }),

      payload: Effect.fn("EnvironmentService.payload")(function* (id) {
        yield* load(id);
        const [built] = yield* buildPayloads(database, id);
        return JSON.stringify(built?.payload ?? null, null, 2);
      }),
    };
  }),
);
