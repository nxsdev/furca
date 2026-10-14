import type { Actor } from "@furca/core/audit/AuditLog";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import {
  type DecisionOutcome,
  Experiment,
  ExperimentDecision,
  ExperimentPhase,
  trafficChangeNeedsNewPhase,
} from "@furca/core/experiments/Experiment";
import { type ExperimentDraft, ExperimentService, type TrafficChange } from "@furca/core/experiments/ExperimentService";
import { ExperimentRule, type FeatureRule, FeatureValueType, ForceRule, validateFeatureValue } from "@furca/core/features/Feature";
import { experimentReach, shadowedBy } from "@furca/core/features/ruleReach";
import { type ErrorCode, ForbiddenError, issue, NotFoundError } from "@furca/core/shared/errors";
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
// The plan only sizes the test (no effect on assignment), so it can be set once data shows it was missing
const MUTABLE_AFTER_START = new Set<keyof ExperimentDraft>(["name", "hypothesis", "secondaryMetricIds", "guardrailMetricIds", "plan"]);

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
  if (!(traffic.coverage > 0 && traffic.coverage <= 1)) return invalid("experiment.coverageRange", undefined, "coverage");
  if (traffic.weights.length !== variations) return invalid("experiment.weightPerVariation");
  if (traffic.weights.some((w) => !(w >= 0))) return invalid("experiment.weightsNegative");
  if (Math.abs(traffic.weights.reduce((a, b) => a + b, 0) - 1) > 1e-6) return invalid("experiment.weightsSum");
  return Effect.void;
};

type RuleTransform = (rules: ReadonlyArray<FeatureRule>, featureId: string, environmentId: string) => ReadonlyArray<FeatureRule>;

/** A computed experiment state change: the audit action, the new experiment and its flag rule writes */
export interface Transition {
  readonly action: string;
  readonly after: Experiment;
  readonly writes: (db: Db) => Array<BatchItem>;
}

export interface StopDecision {
  readonly outcome: DecisionOutcome;
  readonly variationKey: string | null;
  readonly reason: string;
}

/** The experiments row columns except id, createdAt and archivedAt */
const columns = (after: Experiment) => ({
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
});

/**
 * Experiment loading, validation and the start / traffic / stop transitions. Shared with reviews:
 * ChangeRequestServiceLive applies approved experiment changes through the same transitions
 */
export const makeExperimentOps = Effect.gen(function* () {
  const database = yield* Database;

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
      if (metric === undefined) return yield* invalid("experiment.metricGone");
      if (metric.archivedAt !== null) return yield* invalid("experiment.metricArchived", { metric: metric.name });
      if (metric.dataSourceId !== dataSourceId) {
        return yield* invalid("experiment.metricOtherSource", { metric: metric.name });
      }
    }
  });

  /** The namespace exists and the slice is a non-empty range inside [0, 1] */
  const validateNamespace = Effect.fn("ExperimentService.validateNamespace")(function* (allocation: Experiment["namespace"]) {
    if (allocation === null) return;
    if (!(allocation.start >= 0 && allocation.start < allocation.end && allocation.end <= 1)) {
      return yield* invalid("experiment.namespaceSliceRange", undefined, "namespace");
    }
    const row = yield* database.run("namespaces.get", (db) => db.query.namespaces.findFirst({ where: { id: allocation.namespaceId } }));
    if (row === undefined) return yield* invalid("experiment.namespaceGone", undefined, "namespace");
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
      return yield* invalid("experiment.namespaceOverlap", { experiment: clash.name }, "namespace");
    }
  });

  const validateDraft = Effect.fn("ExperimentService.validateDraft")(function* (draft: ExperimentDraft) {
    if (draft.name.trim() === "") return yield* invalid("common.nameRequired", undefined, "name");
    if (draft.variations.length < 2) return yield* invalid("experiment.twoVariations", undefined, "variations");
    const keys = draft.variations.map((v) => v.key.trim());
    if (keys.some((k) => k === "")) return yield* invalid("experiment.variationKeyRequired", undefined, "variations");
    if (new Set(keys).size !== keys.length) return yield* invalid("experiment.variationKeysUnique", undefined, "variations");
    yield* validateTraffic(draft, draft.variations.length);
    if (draft.hashAttribute.trim() === "") return yield* invalid("experiment.hashAttributeRequired", undefined, "hashAttribute");
    if (draft.dimensions.length > 5) return yield* invalid("experiment.tooManyDimensions", undefined, "dimensions");
    if (draft.dimensions.some((d) => d.trim() === "" || d.length > 64 || /["\\]/.test(d))) {
      return yield* invalid("experiment.dimensionName", undefined, "dimensions");
    }
    if (new Set(draft.dimensions).size !== draft.dimensions.length) return yield* invalid("experiment.dimensionTwice", undefined, "dimensions");
    if (draft.environmentIds.length === 0) return yield* invalid("experiment.environmentRequired");
    if (new Set(draft.environmentIds).size !== draft.environmentIds.length) return yield* invalid("experiment.environmentTwice");
    if (!draft.environmentIds.includes(draft.analysisEnvironmentId)) {
      return yield* invalid("experiment.analysisEnvironment", undefined, "analysisEnvironmentId");
    }
    if (!(draft.stats.alpha > 0 && draft.stats.alpha < 1)) return yield* invalid("experiment.alphaRange", undefined, "stats");
    yield* requireGroups(database, [{ rule: null, conditions: draft.conditions }]);
    yield* validateNamespace(draft.namespace);

    const feature = yield* database.run("features.get", (db) => db.query.features.findFirst({ where: { id: draft.featureId } }));
    if (feature === undefined) return yield* invalid("experiment.flagGone", undefined, "featureId");
    if (feature.archivedAt !== null) return yield* invalid("experiment.flagArchived", undefined, "featureId");
    for (const v of draft.variations) {
      const reason = validateFeatureValue(valueType(feature.valueType), v.value);
      if (reason !== null) return yield* invalid("experiment.variationValueInvalid", { variation: v.key, reason }, "variations");
    }
    const envs = yield* database.run("environments.byIds", (db) =>
      db.query.environments.findMany({ where: { id: { in: [...draft.environmentIds] } } }),
    );
    if (envs.length !== draft.environmentIds.length) return yield* invalid("experiment.environmentGone");
    const source = yield* database.run("dataSources.get", (db) =>
      db.query.dataSources.findFirst({ where: { id: draft.dataSourceId } }),
    );
    if (source === undefined) return yield* invalid("dataSource.gone");
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

  const requireStatus = (e: Experiment, status: Experiment["status"], code: ErrorCode) =>
    e.status === status ? Effect.void : invalid(code);

  /**
   * Starting, changing traffic and stopping rewrite what the flag serves in every environment of the
   * experiment, so they go through a review (changeRequests) when any of them requires approval
   */
  const requireNoReview = (e: Experiment) =>
    database
      .run("environments.reviewed", (db) =>
        db.query.environments.findFirst({
          columns: { name: true },
          where: { id: { in: [...e.environmentIds] }, requireApproval: true },
          orderBy: { sortOrder: "asc" },
        }),
      )
      .pipe(
        Effect.flatMap((env) =>
          env === undefined ? Effect.void : Effect.fail(new ForbiddenError(issue("review.required", { environment: env.name }))),
        ),
      );

  /** A started experiment whose rule sits below a rule that serves everyone would never enroll anyone */
  const requireReachable = Effect.fn("ExperimentService.requireReachable")(function* (e: Experiment) {
    const [rows, siblings, envs] = yield* database.run("experiments.reach", (db) =>
      Promise.all([
        db.query.featureEnvironments.findMany({ where: { featureId: e.featureId, environmentId: { in: [...e.environmentIds] } } }),
        db.query.experiments.findMany({ where: { featureId: e.featureId, id: { ne: e.id } } }),
        db.query.environments.findMany({ columns: { id: true, name: true }, where: { id: { in: [...e.environmentIds] } } }),
      ]),
    );
    const reach = new Map(siblings.map((row) => [row.id, experimentReach(toExperiment(row))]));
    reach.set(e.id, experimentReach(e));
    for (const row of rows) {
      const rules = syncRule(e)(toRules(row.rules), row.featureId, row.environmentId);
      const blocker = shadowedBy(rules, (id) => reach.get(id))[rules.findIndex(isRuleOf(e.id))];
      if (blocker !== null && blocker !== undefined) {
        const env = envs.find((x) => x.id === row.environmentId)?.name ?? row.environmentId;
        return yield* invalid("experiment.unreachable", { environment: env, rule: blocker + 1 });
      }
    }
  });

  const prepareStart = Effect.fn("ExperimentService.prepareStart")(function* (before: Experiment, now: Date) {
    yield* requireStatus(before, "draft", "experiment.startDraftOnly");
    if (before.primaryMetricId === null) return yield* invalid("experiment.primaryMetricRequired", undefined, "primaryMetricId");
    yield* validateDraft(before);
    yield* requireFreeSlice(before);
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
    yield* requireReachable(after);
    const writes = yield* ruleWrites([after.featureId], syncRule(after));
    return { action: "started", after, writes } satisfies Transition;
  });

  const prepareTraffic = Effect.fn("ExperimentService.prepareTraffic")(function* (before: Experiment, input: TrafficChange, now: Date) {
    yield* requireStatus(before, "running", "experiment.trafficRunningOnly");
    yield* validateTraffic(input, before.variations.length);
    yield* requireGroups(database, [{ rule: null, conditions: input.conditions }]);
    const current = before.phases.at(-1);
    if (current === undefined) return yield* invalid("experiment.noOpenPhase");
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
    return { action: newPhase ? "phase.started" : "traffic.updated", after, writes: () => [] } satisfies Transition;
  });

  /** `decidedBy`: who made the decision (for a reviewed stop, the author of the request) */
  const prepareStop = Effect.fn("ExperimentService.prepareStop")(function* (
    before: Experiment,
    input: StopDecision,
    decidedBy: string,
    now: Date,
  ) {
    yield* requireStatus(before, "running", "experiment.stopRunningOnly");
    const variation = input.outcome === "ship" ? before.variations.find((v) => v.key === input.variationKey) : undefined;
    if (input.outcome === "ship" && variation === undefined) return yield* invalid("experiment.shipVariationRequired", undefined, "choice");
    const current = before.phases.at(-1);
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
        decidedBy,
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
    return { action: "stopped", after, writes } satisfies Transition;
  });

  return {
    load,
    validateDraft,
    validateMetrics,
    ruleWrites,
    requireStatus,
    requireNoReview,
    prepareStart,
    prepareTraffic,
    prepareStop,
  };
});

/** The experiments row update for `after`, for the same batch as its rule writes */
export const experimentUpdate = (db: Db, before: Experiment, after: Experiment) =>
  db
    .update(experiments)
    .set({ ...columns(after), ...(before.archived === after.archived ? {} : { archivedAt: after.archived ? after.updatedAt : null }) })
    .where(eq(experiments.id, after.id));

export const ExperimentServiceLive = Layer.effect(
  ExperimentService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;
    const {
      load,
      validateDraft,
      validateMetrics,
      ruleWrites,
      requireStatus,
      requireNoReview,
      prepareStart,
      prepareTraffic,
      prepareStop,
    } = yield* makeExperimentOps;

    // ponytail: read-modify-write of flag rules without a lock; concurrent edits of one flag can lose a write
    const save = Effect.fn("ExperimentService.save")(function* (
      action: string,
      actor: Actor,
      before: Experiment | null,
      after: Experiment,
      writes: (db: Db) => Array<BatchItem>,
      republish: boolean,
    ) {
      yield* database.run(`experiments.${action}`, (db) =>
        batch(db, [
          before === null
            ? db.insert(experiments).values({ id: after.id, createdAt: after.createdAt, archivedAt: null, ...columns(after) })
            : experimentUpdate(db, before, after),
          ...writes(db),
          auditInsert(db, { entityType: "experiment", entityId: after.id, action, actor, before, after }),
        ]),
      );
      if (republish) yield* publishAll(database, store);
      yield* emitExperimentEvent(action, after, actor);
      return after;
    });

    const commit = (before: Experiment, actor: Actor, t: Transition) => save(t.action, actor, before, t.after, t.writes, true);

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
        if (existing !== undefined) return yield* invalid("experiment.keyTaken", { key }, "key");
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
          return yield* invalid("experiment.lockedAfterStart", { fields: locked.join(", ") });
        }
        if (draft.name.trim() === "") return yield* invalid("common.nameRequired", undefined, "name");
        yield* validateMetrics([...draft.secondaryMetricIds, ...draft.guardrailMetricIds], before.dataSourceId);
        const after = Experiment.make({
          ...before,
          name: draft.name,
          hypothesis: draft.hypothesis,
          secondaryMetricIds: draft.secondaryMetricIds,
          guardrailMetricIds: draft.guardrailMetricIds,
          plan: draft.plan,
          updatedAt: now,
        });
        return yield* save("updated", actor, before, after, () => [], false);
      }),

      start: Effect.fn("ExperimentService.start")(function* (id, actor) {
        const before = yield* load(id);
        yield* requireNoReview(before);
        return yield* commit(before, actor, yield* prepareStart(before, new Date()));
      }),

      updateTraffic: Effect.fn("ExperimentService.updateTraffic")(function* (input, actor) {
        const before = yield* load(input.id);
        yield* requireNoReview(before);
        return yield* commit(before, actor, yield* prepareTraffic(before, input, new Date()));
      }),

      stop: Effect.fn("ExperimentService.stop")(function* (input, actor) {
        const before = yield* load(input.id);
        yield* requireNoReview(before);
        return yield* commit(before, actor, yield* prepareStop(before, input, actor.email, new Date()));
      }),

      archive: Effect.fn("ExperimentService.archive")(function* (input, actor) {
        const before = yield* load(input.id);
        if (input.archived && before.status === "running") return yield* invalid("experiment.stopBeforeArchive");
        const after = Experiment.make({ ...before, archived: input.archived, updatedAt: new Date() });
        return yield* save(input.archived ? "archived" : "unarchived", actor, before, after, () => [], false);
      }),

      delete: Effect.fn("ExperimentService.delete")(function* (id, actor) {
        const before = yield* load(id);
        yield* requireStatus(before, "draft", "experiment.deleteDraftOnly");
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
