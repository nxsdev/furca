import { Schema } from "effect";
import { DecisionOutcome } from "../experiments/Experiment";
import { FeatureRule } from "../features/Feature";
import { Condition } from "../targeting/Condition";

/**
 * A proposed change to one flag in one environment. The experiment.* changes are experiment
 * actions that rewrite the flag's rules in every environment the experiment runs in; they are
 * reviewed when any of those environments requires approval (`environmentId` is that environment)
 */
export const FlagChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("toggle"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("rules"), rules: Schema.Array(FeatureRule) }),
  Schema.Struct({ type: Schema.Literal("experiment.start"), experimentId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("experiment.traffic"),
    experimentId: Schema.String,
    coverage: Schema.Finite,
    weights: Schema.Array(Schema.Finite),
    conditions: Schema.Array(Condition),
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("experiment.stop"),
    experimentId: Schema.String,
    outcome: DecisionOutcome,
    variationKey: Schema.NullOr(Schema.String),
    reason: Schema.String,
  }),
]);
export type FlagChange = typeof FlagChange.Type;
export type ExperimentChange = Extract<FlagChange, { readonly type: `experiment.${string}` }>;
export const isExperimentChange = (change: FlagChange): change is ExperimentChange => change.type.startsWith("experiment.");

/** A flag's state in one environment */
export const FlagState = Schema.Struct({ enabled: Schema.Boolean, rules: Schema.Array(FeatureRule) });
export type FlagState = typeof FlagState.Type;

export const ChangeRequestStatus = Schema.Literals(["open", "approved", "rejected", "cancelled"]);
export type ChangeRequestStatus = typeof ChangeRequestStatus.Type;

/**
 * A flag change waiting for an admin's review, for environments that require approval.
 * Approving applies `change` only while the environment still matches `base`
 */
export class ChangeRequest extends Schema.Class<ChangeRequest>("ChangeRequest")({
  id: Schema.String,
  featureId: Schema.String,
  /** Flag keys never change, so the key is kept for lists */
  featureKey: Schema.String,
  environmentId: Schema.String,
  change: FlagChange,
  /** The environment's state when the request was opened */
  base: FlagState,
  comment: Schema.String,
  status: ChangeRequestStatus,
  authorId: Schema.String,
  authorEmail: Schema.String,
  reviewerId: Schema.NullOr(Schema.String),
  reviewerEmail: Schema.NullOr(Schema.String),
  reviewComment: Schema.String,
  createdAt: Schema.Date,
  reviewedAt: Schema.NullOr(Schema.Date),
}) {}
