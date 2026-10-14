import type { Actor } from "@furca/core/audit/AuditLog";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import {
  Experiment,
  ExperimentDecision,
  ExperimentPhase,
  trafficChangeNeedsNewPhase,
} from "@furca/core/experiments/Experiment";
import { type ExperimentDraft, ExperimentService } from "@furca/core/experiments/ExperimentService";
import { ExperimentRule, type FeatureRule, FeatureValueType, ForceRule, validateFeatureValue } from "@furca/core/features/Feature";
import { NotFoundError } from "@furca/core/shared/errors";
import { Database, type Db } from "@furca/database/Database";
import { experiments, featureEnvironments } from "@furca/database/schema/index";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { experimentJsonColumns, rulesJson, toExperiment, toRules } from "../mappers";
import { publishAll } from "../payload";
import { auditInsert, batch, type BatchItem, invalid, newId, randomHex } from "../shared";
import { requireGroups } from "../targeting";
import { emitExperimentEvent } from "../webhooks";

/** Fields that may still change once an experiment has started */
const MUTABLE_AFTER_START = new Set<keyof ExperimentDraft>(["name", "hypothesis", "secondaryMetricIds", "guardrailMetricIds"]);

const DRAFT_KEYS = [
  "name",
  "hypothesis",
  "featureId",
  "environmentIds",
  "analysisEnvironmentId",
  "hashAttribute",
  "variations",
  "coverage",
  "weights",
  "conditions",
  "dataSourceId",
  "primaryMetricId",
  "secondaryMetricIds",
  "guardrailMetricIds",
  "stats",
  "plan",
  "namespace",
  "dimensions",
] as const satisfies ReadonlyArray<keyof ExperimentDraft>;

/** Order-stable JSON of one experiment field, for "did it change?" checks */
const canonical = (key: keyof ExperimentDraft, value: unknown) =>
  JSON.stringify(Schema.encodeUnknownSync(Experiment.fields[key])(value));

const newSeed = () => randomHex(8);
const valueType = Schema.decodeUnknownSync(FeatureValueType);

const isRuleOf = (experimentId: string) => (rule: FeatureRule) =>
  rule._tag === "experiment" && rule.experimentId === experimentId;

/** Keeps exactly one rule of the experiment, at the top, in each of its environments of its flag */
const syncRule =
  (e: Experiment) =>
  (rules: ReadonlyArray<FeatureRule>, featureId: string, environmentId: string): ReadonlyArray<FeatureRule> => {
    const want = featureId === e.featureId && e.environmentIds.includes(environmentId);
    const has = rules.some(isRuleOf(e.id));
    if (want && !has) return [ExperimentRule.make({ id: newId(), enabled: true, experimentId: e.id }), ...rules];
    if (!want && has) return rules.filter((r) => !isRuleOf(e.id)(r));
    return rules;
  };

const removeRule = (experimentId: string) => (rules: ReadonlyArray<FeatureRule>) =>
  rules.some(isRuleOf(experimentId)) ? rules.filter((r) => !isRuleOf(experimentId)(r)) : rules;

const validateTraffic = (traffic: { readonly coverage: number; readonly weights: ReadonlyArray<number> }, variations: number) => {
  if (!(traffic.coverage > 0 && traffic.coverage <= 1)) return invalid("Coverage must be more than 0% and at most 100%");
  if (traffic.weights.length !== variations) return invalid("Provide one weight per variation");
  if (traffic.weights.some((w) => !(w >= 0))) return invalid("Weights cannot be negative");
  if (Math.abs(traffic.weights.reduce((a, b) => a + b, 0) - 1) > 1e-6) return invalid("Weights must add up to 100%");
  return Effect.void;
};

type RuleTransform = (rules: ReadonlyArray<FeatureRule>, featureId: string, environmentId: string) => ReadonlyArray<FeatureRule>;

export const ExperimentServiceLive = Layer.effect(
  ExperimentService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;

    const load = (id: string) =>
      database
        .run("experiments.get", (db) => db.query.experiments.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) =>
            row ? Effect.succeed(toExperiment(row)) : Effect.fail(new NotFoundError({ entity: "experiment", id })),
          ),
        );

    /** Metrics must exist, be active and read from the experiment's data source */
    const validateMetrics = Effect.fn("ExperimentService.validateMetrics")(function* (
      ids: ReadonlyArray<string>,
      dataSourceId: string,
    ) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      const rows = yield* database.run("metrics.byIds", (db) => db.query.metrics.findMany({ where: { id: { in: unique } } }));
      for (const id of unique) {
        const metric = rows.find((m) => m.id === id);
        if (metric === undefined) return yield* invalid("A selected metric no longer exists");
        if (metric.archivedAt !== null) return yield* invalid(`Metric "${metric.name}" is archived`);
        if (metric.dataSourceId !== dataSourceId) {
          return yield* invalid(`Metric "${metric.name}" reads from a different data source than the experiment`);
        }
      }
    });

    /** The namespace exists and the slice is a non-empty range inside [0, 1] */
    const validateNamespace = Effect.fn("ExperimentService.validateNamespace")(function* (allocation: Experiment["namespace"]) {
      if (allocation === null) return;
      if (!(allocation.start >= 0 && allocation.start < allocation.end && allocation.end <= 1)) {
        return yield* invalid("The namespace slice must start before it ends, between 0% and 100%");
      }
      const row = yield* database.run("namespaces.get", (db) => db.query.namespaces.findFirst({ where: { id: allocation.namespaceId } }));
      if (row === undefined) return yield* invalid("The selected namespace no longer exists");
    });

    /** Mutual exclusion: no other running experiment may hold an overlapping slice of the same namespace */
    const requireFreeSlice = Effect.fn("ExperimentService.requireFreeSlice")(function* (e: Experiment) {
      const mine = e.namespace;
      if (mine === null) return;
      const running = yield* database.run("experiments.running", (db) =>
        db.query.experiments.findMany({ where: { status: "running", id: { ne: e.id } } }),
      );
      const clash = running
        .map(toExperiment)
        .find((o) => o.namespace?.namespaceId === mine.namespaceId && o.namespace.start < mine.end && mine.start < o.namespace.end);
      if (clash !== undefined) {
        return yield* invalid(
          `The namespace slice overlaps "${clash.name}", which is running in the same namespace. Choose a free range or stop that experiment first`,
        );
      }
    });

    const validateDraft = Effect.fn("ExperimentService.validateDraft")(function* (draft: ExperimentDraft) {
      if (draft.name.trim() === "") return yield* invalid("Name is required");
      if (draft.variations.length < 2) return yield* invalid("An experiment needs at least two variations");
      const keys = draft.variations.map((v) => v.key.trim());
      if (keys.some((k) => k === "")) return yield* invalid("Every variation needs a key");
      if (new Set(keys).size !== keys.length) return yield* invalid("Variation keys must be unique");
      yield* validateTraffic(draft, draft.variations.length);
      if (draft.hashAttribute.trim() === "") return yield* invalid("Choose the attribute to hash users by");
      if (draft.dimensions.length > 5) return yield* invalid("Record at most 5 breakdown attributes");
      if (draft.dimensions.some((d) => d.trim() === "" || d.length > 64 || /["\\]/.test(d))) {
        return yield* invalid('Breakdown attributes need a name of at most 64 characters without " or \\');
      }
      if (new Set(draft.dimensions).size !== draft.dimensions.length) return yield* invalid("Each breakdown attribute can be chosen once");
      if (draft.environmentIds.length === 0) return yield* invalid("Choose at least one environment");
      if (new Set(draft.environmentIds).size !== draft.environmentIds.length) return yield* invalid("Each environment can be chosen once");
      if (!draft.environmentIds.includes(draft.analysisEnvironmentId)) {
        return yield* invalid("The analysis environment must be one of the experiment's environments");
      }
      if (!(draft.stats.alpha > 0 && draft.stats.alpha < 1)) return yield* invalid("Significance level must be between 0 and 1");
      yield* requireGroups(database, [{ where: "Targeting", conditions: draft.conditions }]);
      yield* validateNamespace(draft.namespace);

      const feature = yield* database.run("features.get", (db) => db.query.features.findFirst({ where: { id: draft.featureId } }));
      if (feature === undefined) return yield* invalid("The selected flag no longer exists");
      if (feature.archivedAt !== null) return yield* invalid("Archived flags cannot run experiments");
      for (const v of draft.variations) {
        const error = validateFeatureValue(valueType(feature.valueType), v.value);
        if (error !== null) return yield* invalid(`Variation "${v.key}": ${error}`);
      }
      const envs = yield* database.run("environments.byIds", (db) =>
        db.query.environments.findMany({ where: { id: { in: [...draft.environmentIds] } } }),
      );
      if (envs.length !== draft.environmentIds.length) return yield* invalid("A selected environment no longer exists");
      const source = yield* database.run("dataSources.get", (db) =>
        db.query.dataSources.findFirst({ where: { id: draft.dataSourceId } }),
      );
      if (source === undefined) return yield* invalid("The selected data source no longer exists");
      yield* validateMetrics(
        [...(draft.primaryMetricId === null ? [] : [draft.primaryMetricId]), ...draft.secondaryMetricIds, ...draft.guardrailMetricIds],
        draft.dataSourceId,
      );
    });

    /** feature_environments updates for the rows of `featureIds` whose rules the transform changes */
    const ruleWrites = Effect.fn("ExperimentService.ruleWrites")(function* (
      featureIds: ReadonlyArray<string>,
      transform: RuleTransform,
    ) {
      const rows = yield* database.run("featureEnvironments.byFeatures", (db) =>
        db.query.featureEnvironments.findMany({ where: { featureId: { in: [...new Set(featureIds)] } } }),
      );
      return (db: Db): Array<BatchItem> =>
        rows.flatMap((row) => {
          const current = toRules(row.rules);
          const next = transform(current, row.featureId, row.environmentId);
          if (next === current) return [];
          return [
            db
              .update(featureEnvironments)
              .set({ rules: rulesJson(next) })
              .where(and(eq(featureEnvironments.featureId, row.featureId), eq(featureEnvironments.environmentId, row.environmentId))),
          ];
        });
    });

    // ponytail: read-modify-write of flag rules without a lock; concurrent edits of one flag can lose a write
    const save = Effect.fn("ExperimentService.save")(function* (
      action: string,
      actor: Actor,
      before: Experiment | null,
      after: Experiment,
      writes: (db: Db) => Array<BatchItem>,
      republish: boolean,
    ) {
      const values = {
        key: after.key,
        name: after.name,
        hypothesis: after.hypothesis,
        status: after.status,
        featureId: after.featureId,
        analysisEnvironmentId: after.analysisEnvironmentId,
        hashAttribute: after.hashAttribute,
        coverage: after.coverage,
        dataSourceId: after.dataSourceId,
        primaryMetricId: after.primaryMetricId,
        updatedAt: after.updatedAt,
        startedAt: after.startedAt,
        stoppedAt: after.stoppedAt,
        ...experimentJsonColumns(after),
      };
      yield* database.run(`experiments.${action}`, (db) =>
        batch(db, [
          before === null
            ? db.insert(experiments).values({ id: after.id, createdAt: after.createdAt, archivedAt: null, ...values })
            : db
                .update(experiments)
                .set({ ...values, ...(before.archived === after.archived ? {} : { archivedAt: after.archived ? after.updatedAt : null }) })
                .where(eq(experiments.id, after.id)),
          ...writes(db),
          auditInsert(db, { entityType: "experiment", entityId: after.id, action, actor, before, after }),
        ]),
      );
      if (republish) yield* publishAll(database, store);
      yield* emitExperimentEvent(action, after, actor);
      return after;
    });

    const requireStatus = (e: Experiment, status: Experiment["status"], message: string) =>
      e.status === status ? Effect.void : invalid(message);

    return {
      list: (includeArchived) =>
        database
          .run("experiments.list", (db) =>
            db.query.experiments.findMany({
              where: includeArchived ? {} : { archivedAt: { isNull: true } },
              orderBy: { createdAt: "desc" },
            }),
          )
          .pipe(Effect.map((rows) => rows.map(toExperiment))),

      get: load,

      create: Effect.fn("ExperimentService.create")(function* (input, actor) {
        const { key, ...draft } = input;
        yield* validateDraft(draft);
        const existing = yield* database.run("experiments.byKey", (db) => db.query.experiments.findFirst({ where: { key } }));
        if (existing !== undefined) return yield* invalid(`An experiment with key "${key}" already exists`);
        const now = new Date();
        const experiment = Experiment.make({
          ...draft,
          id: newId(),
          key,
          status: "draft",
          phases: [],
          decision: null,
          archived: false,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          stoppedAt: null,
        });
        const writes = yield* ruleWrites([experiment.featureId], syncRule(experiment));
        // Draft rules are not served: payloads do not change
        return yield* save("created", actor, null, experiment, writes, false);
      }),

      update: Effect.fn("ExperimentService.update")(function* (input, actor) {
        const { id, ...draft } = input;
        const before = yield* load(id);
        const now = new Date();
        if (before.status === "draft") {
          yield* validateDraft(draft);
          const after = Experiment.make({ ...before, ...draft, updatedAt: now });
          const writes = yield* ruleWrites([before.featureId, after.featureId], syncRule(after));
          return yield* save("updated", actor, before, after, writes, false);
        }
        const locked = DRAFT_KEYS.filter((k) => !MUTABLE_AFTER_START.has(k) && canonical(k, before[k]) !== canonical(k, draft[k]));
        if (locked.length > 0) {
          return yield* invalid(
            `Only the name, hypothesis, secondary and guardrail metrics can change after the experiment has started (changed: ${locked.join(", ")})`,
          );
        }
        if (draft.name.trim() === "") return yield* invalid("Name is required");
        yield* validateMetrics([...draft.secondaryMetricIds, ...draft.guardrailMetricIds], before.dataSourceId);
        const after = Experiment.make({
          ...before,
          name: draft.name,
          hypothesis: draft.hypothesis,
          secondaryMetricIds: draft.secondaryMetricIds,
          guardrailMetricIds: draft.guardrailMetricIds,
          updatedAt: now,
        });
        return yield* save("updated", actor, before, after, () => [], false);
      }),

      start: Effect.fn("ExperimentService.start")(function* (id, actor) {
        const before = yield* load(id);
        yield* requireStatus(before, "draft", "Only draft experiments can be started");
        if (before.primaryMetricId === null) return yield* invalid("Choose a primary metric before starting");
        yield* validateDraft(before);
        yield* requireFreeSlice(before);
        const now = new Date();
        const after = Experiment.make({
          ...before,
          status: "running",
          startedAt: now,
          updatedAt: now,
          phases: [
            ExperimentPhase.make({
              startedAt: now,
              endedAt: null,
              coverage: before.coverage,
              weights: before.weights,
              conditions: before.conditions,
              seed: newSeed(),
              reason: "Experiment started",
            }),
          ],
        });
        const writes = yield* ruleWrites([after.featureId], syncRule(after));
        return yield* save("started", actor, before, after, writes, true);
      }),

      updateTraffic: Effect.fn("ExperimentService.updateTraffic")(function* (input, actor) {
        const before = yield* load(input.id);
        yield* requireStatus(before, "running", "Traffic can only change while the experiment is running");
        yield* validateTraffic(input, before.variations.length);
        yield* requireGroups(database, [{ where: "Targeting", conditions: input.conditions }]);
        const current = before.phases.at(-1);
        if (current === undefined) return yield* invalid("The experiment has no open phase");
        const now = new Date();
        const newPhase = trafficChangeNeedsNewPhase(current, input);
        const closed = before.phases.slice(0, -1);
        const phases = newPhase
          ? [
              ...closed,
              ExperimentPhase.make({ ...current, endedAt: now }),
              ExperimentPhase.make({
                startedAt: now,
                endedAt: null,
                coverage: input.coverage,
                weights: input.weights,
                conditions: input.conditions,
                seed: newSeed(),
                reason: input.reason.trim() === "" ? "Traffic changed" : input.reason.trim(),
              }),
            ]
          : [...closed, ExperimentPhase.make({ ...current, coverage: input.coverage })];
        const after = Experiment.make({
          ...before,
          coverage: input.coverage,
          weights: input.weights,
          conditions: input.conditions,
          phases,
          updatedAt: now,
        });
        return yield* save(newPhase ? "phase.started" : "traffic.updated", actor, before, after, () => [], true);
      }),

      stop: Effect.fn("ExperimentService.stop")(function* (input, actor) {
        const before = yield* load(input.id);
        yield* requireStatus(before, "running", "Only running experiments can be stopped");
        const variation = input.outcome === "ship" ? before.variations.find((v) => v.key === input.variationKey) : undefined;
        if (input.outcome === "ship" && variation === undefined) return yield* invalid("Choose the variation to ship");
        const current = before.phases.at(-1);
        const now = new Date();
        const after = Experiment.make({
          ...before,
          status: "stopped",
          stoppedAt: now,
          updatedAt: now,
          phases: current === undefined ? before.phases : [...before.phases.slice(0, -1), ExperimentPhase.make({ ...current, endedAt: now })],
          decision: ExperimentDecision.make({
            outcome: input.outcome,
            variationKey: variation?.key ?? null,
            reason: input.reason,
            decidedAt: now,
            decidedBy: actor.email,
          }),
        });
        const ship: RuleTransform = (rules) =>
          variation === undefined || !rules.some(isRuleOf(before.id))
            ? removeRule(before.id)(rules)
            : rules.map((r) =>
                isRuleOf(before.id)(r)
                  ? ForceRule.make({
                      id: newId(),
                      description: `Shipped from experiment ${before.name}`,
                      enabled: true,
                      conditions: current?.conditions ?? before.conditions,
                      value: variation.value,
                    })
                  : r,
              );
        const writes = yield* ruleWrites([before.featureId], ship);
        return yield* save("stopped", actor, before, after, writes, true);
      }),

      archive: Effect.fn("ExperimentService.archive")(function* (input, actor) {
        const before = yield* load(input.id);
        if (input.archived && before.status === "running") return yield* invalid("Stop the experiment before archiving it");
        const after = Experiment.make({ ...before, archived: input.archived, updatedAt: new Date() });
        return yield* save(input.archived ? "archived" : "unarchived", actor, before, after, () => [], false);
      }),

      delete: Effect.fn("ExperimentService.delete")(function* (id, actor) {
        const before = yield* load(id);
        yield* requireStatus(before, "draft", "Only draft experiments can be deleted");
        const writes = yield* ruleWrites([before.featureId], removeRule(id));
        yield* database.run("experiments.delete", (db) =>
          batch(db, [
            ...writes(db),
            db.delete(experiments).where(eq(experiments.id, id)),
            auditInsert(db, { entityType: "experiment", entityId: id, action: "deleted", actor, before, after: null }),
          ]),
        );
      }),
    };
  }),
);
