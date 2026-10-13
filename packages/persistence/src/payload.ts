/**
 * SDK payload building and publishing. Every change that can alter what SDKs receive (features,
 * experiments, environments) calls publishAll afterwards
 */
import type { PayloadStoreShape } from "@kuji/core/environments/PayloadStore";
import type { Environment } from "@kuji/core/environments/Environment";
import type { Experiment } from "@kuji/core/experiments/Experiment";
import type { Feature } from "@kuji/core/features/Feature";
import type { Condition } from "@kuji/core/targeting/Condition";
import type { DatabaseShape } from "@kuji/database/Database";
import type { PayloadCondition, PayloadFeature, PayloadRule, SdkPayload } from "@kuji/sdk/types";
import { Effect } from "effect";
import { toEnvironment, toExperiment } from "./mappers";
import { loadFeatures } from "./shared";

const conditionsJson = (conditions: ReadonlyArray<Condition>): Array<PayloadCondition> =>
  conditions.map((c) => ({ attribute: c.attribute, operator: c.operator, values: [...c.values] }));

const toPayloadRule = (rule: Feature["environments"][number]["rules"][number], experiments: ReadonlyMap<string, Experiment>): Array<PayloadRule> => {
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
      return [
        {
          type: "experiment",
          key: experiment.key,
          conditions: conditionsJson(phase.conditions),
          coverage: phase.coverage,
          hashAttribute: experiment.hashAttribute,
          seed: phase.seed,
          phase: experiment.phases.length - 1,
          variations: experiment.variations.map((v) => ({ key: v.key, value: JSON.parse(v.value) })),
          weights: [...phase.weights],
        },
      ];
    }
  }
};

/**
 * Pure payload construction: non-archived features enabled in the environment, enabled rules only,
 * experiment rules only while their experiment runs (current phase traffic)
 */
export const buildPayload = (
  environment: Environment,
  features: ReadonlyArray<Feature>,
  experiments: ReadonlyMap<string, Experiment>,
  now: Date,
): SdkPayload => {
  const out: Record<string, PayloadFeature> = {};
  for (const feature of features) {
    const config = feature.environments.find((e) => e.environmentId === environment.id);
    if (feature.archived || !config?.enabled) continue;
    out[feature.key] = {
      defaultValue: JSON.parse(feature.defaultValue),
      rules: config.rules.flatMap((rule) => toPayloadRule(rule, experiments)),
    };
  }
  return { version: 1, environment: environment.key, generatedAt: now.toISOString(), features: out };
};

/** Payloads of every environment (or just one) from the current database state */
export const buildPayloads = Effect.fn("buildPayloads")(function* (database: DatabaseShape, environmentId?: string) {
  const envRows = yield* database.run("environments.list", (db) =>
    db.query.environments.findMany({ where: { id: environmentId }, orderBy: { sortOrder: "asc" } }),
  );
  const features = yield* loadFeatures(database, { includeArchived: false });
  const running = yield* database.run("experiments.running", (db) => db.query.experiments.findMany({ where: { status: "running" } }));
  const experiments = new Map(running.map((row) => [row.id, toExperiment(row)]));
  const now = new Date();
  return envRows.map((row) => {
    const environment = toEnvironment(row);
    return { environment, payload: buildPayload(environment, features, experiments, now) };
  });
});

/** Rebuilds and stores every environment's payload under its SDK key */
export const publishAll = (database: DatabaseShape, store: PayloadStoreShape) =>
  buildPayloads(database).pipe(
    Effect.flatMap((built) =>
      Effect.forEach(built, ({ environment, payload }) => store.put(environment.sdkKey, JSON.stringify(payload)), {
        concurrency: "unbounded",
        discard: true,
      }),
    ),
    Effect.withSpan("publishAll"),
  );
