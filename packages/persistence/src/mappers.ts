/**
 * D1 row -> domain entity mapping, shared by every repository and the analysis pipeline.
 * JSON columns are decoded with the core Schemas so a malformed row fails loudly
 */
import { DataSource, BigQueryConfig } from "@furca/core/datasources/DataSource";
import { Environment } from "@furca/core/environments/Environment";
import {
  Experiment,
  ExperimentDecision,
  ExperimentPhase,
  ExperimentPlan,
  StatsSettings,
  Variation,
} from "@furca/core/experiments/Experiment";
import { NamespaceAllocation } from "@furca/core/experiments/Namespace";
import { Feature, FeatureEnvironmentConfig, FeatureRule, FeatureValueType } from "@furca/core/features/Feature";
import { Metric, MetricCapping, MetricDefinition, MetricType } from "@furca/core/metrics/Metric";
import { Condition } from "@furca/core/targeting/Condition";
import type * as schema from "@furca/database/schema/index";
import { Schema } from "effect";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(s: S) => Schema.decodeUnknownSync(s);
const strings = decode(Schema.Array(Schema.String));
const numbers = decode(Schema.Array(Schema.Finite));
const conditions = decode(Schema.Array(Condition));
/** feature_environments.rules JSON -> FeatureRule[] */
export const toRules = decode(Schema.Array(FeatureRule));

export const toEnvironment = (row: Row<typeof schema.environments>): Environment =>
  Environment.make({ id: row.id, key: row.key, name: row.name, sdkKey: row.sdkKey, sortOrder: row.sortOrder, createdAt: row.createdAt });

export const toFeature = (
  row: Row<typeof schema.features>,
  environmentRows: ReadonlyArray<Row<typeof schema.featureEnvironments>>,
): Feature =>
  Feature.make({
    id: row.id,
    key: row.key,
    description: row.description,
    valueType: decode(FeatureValueType)(row.valueType),
    defaultValue: row.defaultValue,
    tags: strings(row.tags),
    archived: row.archivedAt !== null,
    environments: environmentRows
      .filter((e) => e.featureId === row.id)
      .map((e) => FeatureEnvironmentConfig.make({ environmentId: e.environmentId, enabled: e.enabled, rules: toRules(e.rules) })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export const toExperiment = (row: Row<typeof schema.experiments>): Experiment =>
  Experiment.make({
    id: row.id,
    key: row.key,
    name: row.name,
    hypothesis: row.hypothesis,
    status: decode(Schema.Literals(["draft", "running", "stopped"]))(row.status),
    featureId: row.featureId,
    environmentIds: strings(row.environmentIds),
    analysisEnvironmentId: row.analysisEnvironmentId,
    hashAttribute: row.hashAttribute,
    variations: decode(Schema.Array(Variation))(row.variations),
    phases: decode(Schema.Array(ExperimentPhase))(revivePhaseDates(row.phases)),
    coverage: row.coverage,
    weights: numbers(row.weights),
    conditions: conditions(row.conditions),
    dataSourceId: row.dataSourceId,
    primaryMetricId: row.primaryMetricId,
    secondaryMetricIds: strings(row.secondaryMetricIds),
    guardrailMetricIds: strings(row.guardrailMetricIds),
    stats: decode(StatsSettings)(row.stats),
    plan: decode(ExperimentPlan)(row.plan),
    dimensions: strings(row.dimensions),
    namespace: row.namespace === null ? null : decode(NamespaceAllocation)(row.namespace),
    decision: row.decision === null ? null : decode(ExperimentDecision)(reviveDates(row.decision, ["decidedAt"])),
    archived: row.archivedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
  });

export const toMetric = (row: Row<typeof schema.metrics>): Metric =>
  Metric.make({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    type: decode(MetricType)(row.type),
    dataSourceId: row.dataSourceId,
    definition: decode(MetricDefinition)(row.definition),
    inverse: row.inverse,
    windowHours: row.windowHours,
    delayHours: row.delayHours,
    capping: decode(MetricCapping)(row.capping),
    archived: row.archivedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export const toDataSource = (row: Row<typeof schema.dataSources>): DataSource =>
  DataSource.make({
    id: row.id,
    name: row.name,
    type: decode(Schema.Literals(["builtin", "bigquery"]))(row.type),
    bigquery: row.config === null ? null : decode(BigQueryConfig)(row.config),
    hasCredentials: row.credentials !== null,
    exposureSql: row.exposureSql,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/**
 * Domain -> JSON column values. Dates inside JSON columns are stored as ISO strings and
 * revived on read
 */
export const experimentJsonColumns = (e: Experiment) => ({
  environmentIds: [...e.environmentIds],
  variations: e.variations.map((v) => ({ key: v.key, name: v.name, value: v.value })),
  phases: e.phases.map((p) => ({ ...p, startedAt: p.startedAt.toISOString(), endedAt: p.endedAt?.toISOString() ?? null })),
  weights: [...e.weights],
  conditions: e.conditions.map((c) => ({ ...c })),
  secondaryMetricIds: [...e.secondaryMetricIds],
  guardrailMetricIds: [...e.guardrailMetricIds],
  stats: { ...e.stats },
  plan: { ...e.plan },
  dimensions: [...e.dimensions],
  namespace: e.namespace === null ? null : { ...e.namespace },
  decision: e.decision === null ? null : { ...e.decision, decidedAt: e.decision.decidedAt.toISOString() },
});

/** FeatureRule[] -> plain JSON (keeps the `_tag` discriminator) */
export const rulesJson = (value: ReadonlyArray<FeatureRule>) => Schema.encodeSync(Schema.Array(FeatureRule))(value);

const reviveDates = (value: unknown, keys: ReadonlyArray<string>): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of keys) if (typeof copy[k] === "string") copy[k] = new Date(copy[k]);
  return copy;
};

const revivePhaseDates = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((p) => reviveDates(p, ["startedAt", "endedAt"])) : value;
