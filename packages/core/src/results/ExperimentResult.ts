import { Schema } from "effect";

export const MetricRole = Schema.Literals(["primary", "secondary", "guardrail"]);
export type MetricRole = typeof MetricRole.Type;

/** Per-variation summary of one metric */
export class VariationMetricSummary extends Schema.Class<VariationMetricSummary>(
  "VariationMetricSummary",
)({
  variationKey: Schema.String,
  users: Schema.Int,
  /** Sum of the per-user metric (numerator for ratio metrics) */
  total: Schema.Finite,
  /** Per-user mean (conversion rate for proportion, ratio of sums for ratio) */
  mean: Schema.Finite,
}) {}

/**
 * winning / losing: significant in the good / bad direction (respecting `inverse`)
 * neutral: not significant; inconclusive: not enough data or the estimate is unusable
 */
export const Verdict = Schema.Literals(["winning", "losing", "neutral", "inconclusive"]);
export type Verdict = typeof Verdict.Type;

/** One treatment variation compared against the control (variation index 0) */
export class VariationComparison extends Schema.Class<VariationComparison>("VariationComparison")({
  variationKey: Schema.String,
  /** Relative lift (treatment - control) / |control| */
  lift: Schema.NullOr(Schema.Finite),
  /** Interval on relative lift: confidence (sequential if enabled) or credible */
  ci: Schema.NullOr(Schema.Tuple([Schema.Finite, Schema.Finite])),
  /** Absolute difference of means */
  absoluteDiff: Schema.NullOr(Schema.Finite),
  /** Frequentist p-value after correction */
  pValue: Schema.NullOr(Schema.Finite),
  /** Bayesian probability that treatment beats control */
  chanceToWin: Schema.NullOr(Schema.Finite),
  verdict: Verdict,
  /** Why the comparison could not be computed, if verdict = inconclusive */
  message: Schema.NullOr(Schema.String),
}) {}

export class TimeseriesPoint extends Schema.Class<TimeseriesPoint>("TimeseriesPoint")({
  /** UTC date (YYYY-MM-DD) of first exposure; values are cumulative up to and including it */
  date: Schema.String,
  users: Schema.Int,
  comparisons: Schema.Array(
    Schema.Struct({
      variationKey: Schema.String,
      lift: Schema.NullOr(Schema.Finite),
      ci: Schema.NullOr(Schema.Tuple([Schema.Finite, Schema.Finite])),
    }),
  ),
}) {}

export class MetricResult extends Schema.Class<MetricResult>("MetricResult")({
  metricId: Schema.String,
  role: MetricRole,
  variations: Schema.Array(VariationMetricSummary),
  comparisons: Schema.Array(VariationComparison),
  timeseries: Schema.Array(TimeseriesPoint),
  /** Cap applied to per-user values, if capping was configured */
  capValue: Schema.NullOr(Schema.Finite),
  cupedApplied: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
}) {}

export class SrmCheck extends Schema.Class<SrmCheck>("SrmCheck")({
  /** Chi-square goodness-of-fit p-value; null until enough users */
  pValue: Schema.NullOr(Schema.Finite),
  observed: Schema.Array(Schema.Int),
  expectedWeights: Schema.Array(Schema.Finite),
  /** false when p < 0.001 */
  ok: Schema.Boolean,
}) {}

export class ExperimentHealth extends Schema.Class<ExperimentHealth>("ExperimentHealth")({
  totalUsers: Schema.Int,
  srm: SrmCheck,
  /** Users exposed to more than one variation; excluded from analysis */
  multipleExposureUsers: Schema.Int,
  /** false when multiple exposures >= 1% of users */
  multipleExposuresOk: Schema.Boolean,
}) {}

/** One analysis run, stored so pages load instantly and history is kept */
export class ResultSnapshot extends Schema.Class<ResultSnapshot>("ResultSnapshot")({
  id: Schema.String,
  experimentId: Schema.String,
  phaseIndex: Schema.Int,
  computedAt: Schema.Date,
  status: Schema.Literals(["ok", "error"]),
  error: Schema.NullOr(Schema.String),
  health: Schema.NullOr(ExperimentHealth),
  metrics: Schema.Array(MetricResult),
}) {}
