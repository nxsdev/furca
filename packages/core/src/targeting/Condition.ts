import { Schema } from "effect";

/** Targeting operators. Values are always strings; numeric / semver comparisons parse at evaluation time */
export const ConditionOperator = Schema.Literals([
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
  "semver_gt",
  "semver_gte",
  "semver_lt",
  "semver_lte",
  "exists",
  "not_exists",
  /** values[0] is a saved group id; `attribute` is ignored (the group defines what it checks) */
  "in_group",
  "not_in_group",
]);
export type ConditionOperator = typeof ConditionOperator.Type;

/** A condition on one attribute. All conditions in a rule are AND-ed */
export class Condition extends Schema.Class<Condition>("Condition")({
  /** User attribute name passed to the SDK (e.g. country, plan, id) */
  attribute: Schema.String,
  operator: ConditionOperator,
  /** in / not_in use all values, exists / not_exists use none, everything else uses the first */
  values: Schema.Array(Schema.String),
}) {}
