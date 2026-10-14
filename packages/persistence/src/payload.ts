/**
 * SDK payload building and publishing. Every change that can alter what SDKs receive (features,
 * experiments, environments) calls publishAll afterwards
 */
import type { PayloadStoreShape } from "@furca/core/environments/PayloadStore";
import type { Environment } from "@furca/core/environments/Environment";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Namespace } from "@furca/core/experiments/Namespace";
import type { Feature } from "@furca/core/features/Feature";
import type { Condition } from "@furca/core/targeting/Condition";
import type { SavedGroup } from "@furca/core/targeting/SavedGroup";
import type { DatabaseShape } from "@furca/database/Database";
import type { PayloadCondition, PayloadFeature, PayloadRule, PayloadSavedGroup, SdkPayload } from "@furca/sdk/types";
import { Effect } from "effect";
import { toEnvironment, toExperiment, toNamespace, toSavedGroup } from "./mappers";
import { loadFeatures } from "./shared";
import { groupIdsOf } from "./targeting";
import { emitWebhook } from "./webhooks";

/** Entities experiment rules and conditions point at, by id */
export interface PayloadRefs {
  readonly savedGroups: ReadonlyMap<string, SavedGroup>;
  readonly namespaces: ReadonlyMap<string, Namespace>;
}

const conditionsJson = (conditions: ReadonlyArray<Condition>): Array<PayloadCondition> =>
  conditions.map((c) => ({ attribute: c.attribute, operator: c.operator, values: [...c.values] }));

const toPayloadRule = (
  rule: Feature["environments"][number]["rules"][number],
  experiments: ReadonlyMap<string, Experiment>,
  namespaces: PayloadRefs["namespaces"],
): Array<PayloadRule> => {
  if (!rule.enabled) return [];
  switch (rule._tag) {
    case "force":
      return [{ type: "force", conditions: conditionsJson(rule.conditions), value: JSON.parse(rule.value) }];
    case "rollout":
      return [
        {
          type: "rollout",
          conditions: conditionsJson(rule.conditions),
          value: JSON.parse(rule.value),
          coverage: rule.coverage,
          hashAttribute: rule.hashAttribute,
          seed: rule.seed,
        },
      ];
    case "experiment": {
      const experiment = experiments.get(rule.experimentId);
      const phase = experiment?.phases.at(-1);
      if (experiment?.status !== "running" || phase === undefined) return [];
      const allocation = experiment.namespace;
      const namespace = allocation === null ? undefined : namespaces.get(allocation.namespaceId);
      return [
        {
          type: "experiment",
          key: experiment.key,
          conditions: conditionsJson(phase.conditions),
          coverage: phase.coverage,
          hashAttribute: experiment.hashAttribute,
          seed: phase.seed,
          phase: experiment.phases.length - 1,
          ...(allocation !== null && namespace !== undefined ? { namespace: [namespace.key, allocation.start, allocation.end] as const } : {}),
          ...(experiment.dimensions.length > 0 ? { dimensions: [...experiment.dimensions] } : {}),
          variations: experiment.variations.map((v) => ({ key: v.key, value: JSON.parse(v.value) })),
          weights: [...phase.weights],
        },
      ];
    }
  }
};

const toPayloadGroup = (group: SavedGroup): PayloadSavedGroup =>
  group.type === "list"
    ? { type: "list", attribute: group.attribute, values: [...group.values] }
    : { type: "condition", conditions: conditionsJson(group.conditions) };

/**
 * Pure payload construction: non-archived features enabled in the environment, enabled rules only,
 * experiment rules only while their experiment runs (current phase traffic), and only the saved
 * groups those rules reference
 */
export const buildPayload = (
  environment: Environment,
  features: ReadonlyArray<Feature>,
  experiments: ReadonlyMap<string, Experiment>,
  now: Date,
  refs: PayloadRefs = { savedGroups: new Map(), namespaces: new Map() },
): SdkPayload => {
  const out: Record<string, PayloadFeature> = {};
  for (const feature of features) {
    const config = feature.environments.find((e) => e.environmentId === environment.id);
    if (feature.archived || !config?.enabled) continue;
    out[feature.key] = {
      defaultValue: JSON.parse(feature.defaultValue),
      rules: config.rules.flatMap((rule) => toPayloadRule(rule, experiments, refs.namespaces)),
    };
  }
  const savedGroups: Record<string, PayloadSavedGroup> = {};
  for (const id of Object.values(out).flatMap((f) => f.rules.flatMap((r) => groupIdsOf(r.conditions)))) {
    const group = refs.savedGroups.get(id);
    if (group !== undefined) savedGroups[id] = toPayloadGroup(group);
  }
  return {
    version: 1,
    environment: environment.key,
    generatedAt: now.toISOString(),
    features: out,
    ...(Object.keys(savedGroups).length > 0 ? { savedGroups } : {}),
  };
};

/** Payloads of every environment (or just one) from the current database state */
export const buildPayloads = Effect.fn("buildPayloads")(function* (database: DatabaseShape, environmentId?: string) {
  const envRows = yield* database.run("environments.list", (db) =>
    db.query.environments.findMany({ where: { id: environmentId }, orderBy: { sortOrder: "asc" } }),
  );
  const features = yield* loadFeatures(database, { includeArchived: false });
  const running = yield* database.run("experiments.running", (db) => db.query.experiments.findMany({ where: { status: "running" } }));
  const experiments = new Map(running.map((row) => [row.id, toExperiment(row)]));
  const [groupRows, namespaceRows] = yield* database.run("payload.refs", (db) =>
    Promise.all([db.query.savedGroups.findMany(), db.query.namespaces.findMany()]),
  );
  const refs: PayloadRefs = {
    savedGroups: new Map(groupRows.map((row) => [row.id, toSavedGroup(row)])),
    namespaces: new Map(namespaceRows.map((row) => [row.id, toNamespace(row)])),
  };
  const now = new Date();
  return envRows.map((row) => {
    const environment = toEnvironment(row);
    return { environment, payload: buildPayload(environment, features, experiments, now, refs) };
  });
});

/** Rebuilds and stores every environment's payload under its SDK key */
export const publishAll = (database: DatabaseShape, store: PayloadStoreShape) =>
  buildPayloads(database).pipe(
    Effect.flatMap((built) =>
      Effect.forEach(built, ({ environment, payload }) => store.put(environment.sdkKey, JSON.stringify(payload)), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(emitWebhook("payload.updated", { environments: built.map(({ environment: e }) => ({ id: e.id, key: e.key })) }))),
    ),
    Effect.withSpan("publishAll"),
  );
