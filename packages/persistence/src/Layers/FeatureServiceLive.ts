import type { Actor } from "@kuji/core/audit/AuditLog";
import { PayloadStore } from "@kuji/core/environments/PayloadStore";
import {
  Feature,
  FeatureEnvironmentConfig,
  type FeatureRule,
  validateFeatureValue,
} from "@kuji/core/features/Feature";
import { FeatureService } from "@kuji/core/features/FeatureService";
import { ConflictError, NotFoundError } from "@kuji/core/shared/errors";
import { Database, type Db } from "@kuji/database/Database";
import { environments, featureEnvironments, features } from "@kuji/database/schema/index";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { rulesJson } from "../mappers";
import { publishAll } from "../payload";
import { auditInsert, batch, type BatchItem, getFeature, invalid, loadFeatures, newId } from "../shared";

const experimentIds = (rules: ReadonlyArray<FeatureRule>) =>
  rules
    .flatMap((r) => (r._tag === "experiment" ? [r.experimentId] : []))
    .sort()
    .join("\n");

/** Error message for the first invalid rule, or null */
export const validateRules = (
  feature: Feature,
  current: ReadonlyArray<FeatureRule>,
  next: ReadonlyArray<FeatureRule>,
): string | null => {
  for (const [i, rule] of next.entries()) {
    if (rule._tag === "experiment") continue;
    const at = `Rule ${i + 1}`;
    const error = validateFeatureValue(feature.valueType, rule.value);
    if (error !== null) return `${at}: ${error}`;
    if (rule._tag === "rollout") {
      if (!(rule.coverage >= 0 && rule.coverage <= 1)) return `${at}: coverage must be between 0% and 100%`;
      if (rule.hashAttribute.trim() === "") return `${at}: choose the attribute to hash users by`;
      if (rule.seed.trim() === "") return `${at}: seed is required`;
    }
  }
  if (experimentIds(next) !== experimentIds(current)) {
    return "Experiment rules belong to their experiment: reorder or toggle them here, but add or remove them from the experiment";
  }
  return null;
};

export const FeatureServiceLive = Layer.effect(
  FeatureService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;

    /** Persists `writes` with an audit row, republishes when SDKs may see a difference */
    const commit = Effect.fn("FeatureService.commit")(function* (
      action: string,
      actor: Actor,
      before: Feature | null,
      after: Feature | null,
      writes: (db: Db) => ReadonlyArray<BatchItem>,
      republish: boolean,
    ) {
      const entityId = (after ?? before)?.id ?? "";
      yield* database.run(`features.${action}`, (db) =>
        batch(db, [...writes(db), auditInsert(db, { entityType: "feature", entityId, action, actor, before, after })]),
      );
      if (republish) yield* publishAll(database, store);
    });

    const environmentConfig = (feature: Feature, environmentId: string) => {
      const config = feature.environments.find((e) => e.environmentId === environmentId);
      return config ? Effect.succeed(config) : Effect.fail(new NotFoundError({ entity: "environment", id: environmentId }));
    };

    const withEnvironment = (feature: Feature, environmentId: string, patch: Partial<FeatureEnvironmentConfig>, now: Date) =>
      Feature.make({
        ...feature,
        updatedAt: now,
        environments: feature.environments.map((e) =>
          e.environmentId === environmentId ? FeatureEnvironmentConfig.make({ ...e, ...patch }) : e,
        ),
      });

    const environmentRow = (id: string, environmentId: string) =>
      and(eq(featureEnvironments.featureId, id), eq(featureEnvironments.environmentId, environmentId));

    return {
      list: (includeArchived) => loadFeatures(database, { includeArchived }),

      get: (id) => getFeature(database, id),

      create: Effect.fn("FeatureService.create")(function* (input, actor) {
        const error = validateFeatureValue(input.valueType, input.defaultValue);
        if (error !== null) return yield* invalid(`Default value: ${error}`);
        const existing = yield* database.run("features.byKey", (db) => db.query.features.findFirst({ where: { key: input.key } }));
        if (existing !== undefined) return yield* invalid(`A flag with key "${input.key}" already exists`);
        const envs = yield* database.run("environments.list", (db) =>
          db.query.environments.findMany({ orderBy: { sortOrder: "asc" } }),
        );
        const now = new Date();
        const feature = Feature.make({
          id: newId(),
          key: input.key,
          description: input.description,
          valueType: input.valueType,
          defaultValue: input.defaultValue,
          tags: [...input.tags],
          archived: false,
          environments: envs.map((e) => FeatureEnvironmentConfig.make({ environmentId: e.id, enabled: false, rules: [] })),
          createdAt: now,
          updatedAt: now,
        });
        // A new flag is disabled everywhere: payloads do not change
        yield* commit("created", actor, null, feature, (db) => [
          db.insert(features).values({
            id: feature.id,
            key: feature.key,
            description: feature.description,
            valueType: feature.valueType,
            defaultValue: feature.defaultValue,
            tags: [...feature.tags],
            createdAt: now,
            updatedAt: now,
          }),
          db
            .insert(featureEnvironments)
            .select(
              db
                .select({
                  featureId: sql<string>`${feature.id}`.as("feature_id"),
                  environmentId: environments.id,
                  enabled: sql<boolean>`0`.as("enabled"),
                  rules: sql<unknown>`'[]'`.as("rules"),
                })
                .from(environments),
            ),
        ], false);
        return feature;
      }),

      update: Effect.fn("FeatureService.update")(function* (input, actor) {
        const before = yield* getFeature(database, input.id);
        const error = validateFeatureValue(before.valueType, input.defaultValue);
        if (error !== null) return yield* invalid(`Default value: ${error}`);
        const now = new Date();
        const after = Feature.make({
          ...before,
          description: input.description,
          defaultValue: input.defaultValue,
          tags: [...input.tags],
          updatedAt: now,
        });
        yield* commit("updated", actor, before, after, (db) => [
          db
            .update(features)
            .set({ description: after.description, defaultValue: after.defaultValue, tags: [...after.tags], updatedAt: now })
            .where(eq(features.id, after.id)),
        ], true);
        return after;
      }),

      setEnabled: Effect.fn("FeatureService.setEnabled")(function* (input, actor) {
        const before = yield* getFeature(database, input.id);
        yield* environmentConfig(before, input.environmentId);
        const now = new Date();
        const after = withEnvironment(before, input.environmentId, { enabled: input.enabled }, now);
        yield* commit(input.enabled ? "enabled" : "disabled", actor, before, after, (db) => [
          db.update(featureEnvironments).set({ enabled: input.enabled }).where(environmentRow(before.id, input.environmentId)),
          db.update(features).set({ updatedAt: now }).where(eq(features.id, before.id)),
        ], true);
        return after;
      }),

      saveRules: Effect.fn("FeatureService.saveRules")(function* (input, actor) {
        const before = yield* getFeature(database, input.id);
        const current = yield* environmentConfig(before, input.environmentId);
        const error = validateRules(before, current.rules, input.rules);
        if (error !== null) return yield* invalid(error);
        const now = new Date();
        const after = withEnvironment(before, input.environmentId, { rules: input.rules }, now);
        yield* commit("rules.updated", actor, before, after, (db) => [
          db.update(featureEnvironments).set({ rules: rulesJson(input.rules) }).where(environmentRow(before.id, input.environmentId)),
          db.update(features).set({ updatedAt: now }).where(eq(features.id, before.id)),
        ], true);
        return after;
      }),

      archive: Effect.fn("FeatureService.archive")(function* (input, actor) {
        const before = yield* getFeature(database, input.id);
        if (input.archived) {
          const running = yield* database.run("experiments.runningForFeature", (db) =>
            db.query.experiments.findFirst({ where: { featureId: before.id, status: "running" } }),
          );
          if (running !== undefined) return yield* invalid(`Stop the experiment "${running.name}" before archiving this flag`);
        }
        const now = new Date();
        const after = Feature.make({ ...before, archived: input.archived, updatedAt: now });
        yield* commit(input.archived ? "archived" : "unarchived", actor, before, after, (db) => [
          db
            .update(features)
            .set({ archivedAt: input.archived ? now : null, updatedAt: now })
            .where(eq(features.id, before.id)),
        ], true);
        return after;
      }),

      delete: Effect.fn("FeatureService.delete")(function* (id, actor) {
        const before = yield* getFeature(database, id);
        const experiment = yield* database.run("experiments.forFeature", (db) =>
          db.query.experiments.findFirst({ where: { featureId: id } }),
        );
        if (experiment !== undefined) {
          return yield* new ConflictError({
            message: `The experiment "${experiment.name}" uses this flag. Archive the flag instead`,
          });
        }
        yield* commit("deleted", actor, before, null, (db) => [
          db.delete(featureEnvironments).where(eq(featureEnvironments.featureId, id)),
          db.delete(features).where(eq(features.id, id)),
        ], true);
      }),
    };
  }),
);
