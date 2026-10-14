import { Schema } from "effect";
import { Condition } from "../targeting/Condition";
import { NamespaceAllocation } from "./Namespace";

export const ExperimentStatus = Schema.Literals(["draft", "running", "stopped"]);
export type ExperimentStatus = typeof ExperimentStatus.Type;

export class Variation extends Schema.Class<Variation>("Variation")({
  /** Stable key sent with exposures (e.g. control, treatment) */
  key: Schema.String,
  name: Schema.String,
  /** JSON-encoded feature value served to this variation. Index 0 is always the control */
  value: Schema.String,
}) {}

/**
 * Traffic allocation period. Any change that can bias results (weights, targeting, lower
 * coverage) closes the current phase and opens a new one with a fresh seed
 */
export class ExperimentPhase extends Schema.Class<ExperimentPhase>("ExperimentPhase")({
  startedAt: Schema.Date,
  endedAt: Schema.NullOr(Schema.Date),
  /** 0..1 share of eligible users that enter the experiment */
  coverage: Schema.Finite,
  /** Same length as variations, sums to 1 */
  weights: Schema.Array(Schema.Finite),
  conditions: Schema.Array(Condition),
  seed: Schema.String,
  reason: Schema.String,
}) {}

export const StatsEngine = Schema.Literals(["frequentist", "bayesian"]);
export type StatsEngine = typeof StatsEngine.Type;

/** Locked when the experiment starts so results cannot be p-hacked by toggling settings */
export class StatsSettings extends Schema.Class<StatsSettings>("StatsSettings")({
  engine: StatsEngine,
  /** Always-valid confidence sequences (frequentist only) */
  sequential: Schema.Boolean,
  /** Total sample (all arms) where the sequential interval is tightest. Defaults to the planned sample */
  sequentialTuning: Schema.Finite,
  /** Significance level, e.g. 0.05 */
  alpha: Schema.Finite,
  /** Variance reduction using the same metric in the 14 days before first exposure */
  cuped: Schema.Boolean,
  /** Multiple-comparison correction across variations x metrics (frequentist only) */
  correction: Schema.Literals(["none", "holm"]),
}) {}

/** Pre-launch power analysis result kept with the experiment */
export class ExperimentPlan extends Schema.Class<ExperimentPlan>("ExperimentPlan")({
  /** Relative minimum detectable effect, e.g. 0.05 = 5% */
  mde: Schema.Finite,
  /** Users per variation needed to reach 80% power, null when not computed */
  sampleSizePerVariation: Schema.NullOr(Schema.Int),
  /** Expected users per day entering the experiment */
  dailyTraffic: Schema.NullOr(Schema.Finite),
}) {}

export const DecisionOutcome = Schema.Literals(["ship", "rollback", "inconclusive"]);
export type DecisionOutcome = typeof DecisionOutcome.Type;

export class ExperimentDecision extends Schema.Class<ExperimentDecision>("ExperimentDecision")({
  outcome: DecisionOutcome,
  /** Variation rolled out when outcome = ship */
  variationKey: Schema.NullOr(Schema.String),
  reason: Schema.String,
  decidedAt: Schema.Date,
  decidedBy: Schema.String,
}) {}

/** Experiment aggregate. Owns its flag rule's variations, weights and targeting */
export class Experiment extends Schema.Class<Experiment>("Experiment")({
  id: Schema.String,
  /** Tracking key sent with exposures; immutable once started */
  key: Schema.String,
  name: Schema.String,
  hypothesis: Schema.String,
  status: ExperimentStatus,
  featureId: Schema.String,
  /** Environments whose flag rules include this experiment */
  environmentIds: Schema.Array(Schema.String),
  /** Environment whose exposures and events are analyzed */
  analysisEnvironmentId: Schema.String,
  /** User attribute hashed for assignment (usually id) */
  hashAttribute: Schema.String,
  variations: Schema.Array(Variation),
  /** Last element is the current phase. Empty while draft */
  phases: Schema.Array(ExperimentPhase),
  /** Draft traffic settings, copied into the first phase on start */
  coverage: Schema.Finite,
  weights: Schema.Array(Schema.Finite),
  conditions: Schema.Array(Condition),
  dataSourceId: Schema.String,
  primaryMetricId: Schema.NullOr(Schema.String),
  secondaryMetricIds: Schema.Array(Schema.String),
  guardrailMetricIds: Schema.Array(Schema.String),
  stats: StatsSettings,
  plan: ExperimentPlan,
  /**
   * User attributes recorded with each exposure so results can be broken down by them
   * (e.g. country, browser). At most 5; the SDK only sends these attributes
   */
  dimensions: Schema.Array(Schema.String),
  /** Mutually exclusive slice of a namespace, or null to run independently */
  namespace: Schema.NullOr(NamespaceAllocation),
  decision: Schema.NullOr(ExperimentDecision),
  archived: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  startedAt: Schema.NullOr(Schema.Date),
  stoppedAt: Schema.NullOr(Schema.Date),
}) {}

/** Defaults: sequential frequentist, because small teams look at results every day */
export const defaultStatsSettings = (): StatsSettings =>
  StatsSettings.make({
    engine: "frequentist",
    sequential: true,
    sequentialTuning: 5000,
    alpha: 0.05,
    cuped: true,
    correction: "holm",
  });

/**
 * A traffic change needs a new phase (and re-randomization) when it can bias the comparison:
 * weights change, targeting changes, or coverage goes down. Raising coverage alone is safe
 */
export const trafficChangeNeedsNewPhase = (
  current: { readonly coverage: number; readonly weights: ReadonlyArray<number>; readonly conditions: ReadonlyArray<Condition> },
  next: { readonly coverage: number; readonly weights: ReadonlyArray<number>; readonly conditions: ReadonlyArray<Condition> },
): boolean =>
  next.coverage < current.coverage ||
  next.weights.length !== current.weights.length ||
  next.weights.some((w, i) => Math.abs(w - (current.weights[i] ?? 0)) > 1e-9) ||
  JSON.stringify(next.conditions) !== JSON.stringify(current.conditions);
