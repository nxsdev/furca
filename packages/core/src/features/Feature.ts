import { Schema } from "effect";
import { Condition } from "../targeting/Condition";

export const FeatureValueType = Schema.Literals(["boolean", "string", "number", "json"]);
export type FeatureValueType = typeof FeatureValueType.Type;

/**
 * Flag values are stored as JSON strings regardless of type (true / "blue" / 3 / {"a":1}).
 * validateFeatureValue checks them against valueType
 */
export const FeatureValueJson = Schema.String;

/** Serves a fixed value to users matching the conditions */
export class ForceRule extends Schema.TaggedClass<ForceRule>()("force", {
  id: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  conditions: Schema.Array(Condition),
  value: FeatureValueJson,
}) {}

/** Serves the value to `coverage` share of users matching the conditions */
export class RolloutRule extends Schema.TaggedClass<RolloutRule>()("rollout", {
  id: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  conditions: Schema.Array(Condition),
  value: FeatureValueJson,
  /** 0..1 */
  coverage: Schema.Finite,
  hashAttribute: Schema.String,
  /** Hash seed, fixed at creation. Changing it reshuffles who gets the value */
  seed: Schema.String,
}) {}

/**
 * A reference to an experiment. Variation values, weights and targeting are owned by the
 * Experiment, so they are never edited in two places
 */
export class ExperimentRule extends Schema.TaggedClass<ExperimentRule>()("experiment", {
  id: Schema.String,
  enabled: Schema.Boolean,
  experimentId: Schema.String,
}) {}

export const FeatureRule = Schema.Union([ForceRule, RolloutRule, ExperimentRule]);
export type FeatureRule = typeof FeatureRule.Type;

/** Per-environment flag config. Disabled flags are left out of the payload, so SDKs return the caller's fallback */
export class FeatureEnvironmentConfig extends Schema.Class<FeatureEnvironmentConfig>(
  "FeatureEnvironmentConfig",
)({
  environmentId: Schema.String,
  enabled: Schema.Boolean,
  /** Evaluated top to bottom; the first matching rule wins */
  rules: Schema.Array(FeatureRule),
}) {}

/** Feature flag aggregate */
export class Feature extends Schema.Class<Feature>("Feature")({
  id: Schema.String,
  /** Unique key referenced from SDKs (e.g. new-checkout) */
  key: Schema.String,
  description: Schema.String,
  valueType: FeatureValueType,
  /** Served when no rule matches */
  defaultValue: FeatureValueJson,
  tags: Schema.Array(Schema.String),
  archived: Schema.Boolean,
  environments: Schema.Array(FeatureEnvironmentConfig),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

/** Checks a JSON-encoded value against valueType; returns an error message or null */
export const validateFeatureValue = (valueType: FeatureValueType, json: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "Value is not valid JSON";
  }
  switch (valueType) {
    case "boolean":
      return typeof parsed === "boolean" ? null : "Expected true or false";
    case "string":
      return typeof parsed === "string" ? null : "Expected a string";
    case "number":
      return typeof parsed === "number" && Number.isFinite(parsed) ? null : "Expected a number";
    case "json":
      return null;
  }
};
