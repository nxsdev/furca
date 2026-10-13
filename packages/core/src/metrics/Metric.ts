import { Schema } from "effect";

/**
 * proportion: share of users with at least one event (conversion rate)
 * mean: per-user count or sum of event values (orders per user, revenue per user)
 * ratio: sum(numerator) / sum(denominator) across users (revenue per order)
 */
export const MetricType = Schema.Literals(["proportion", "mean", "ratio"]);
export type MetricType = typeof MetricType.Type;

export const EventAggregation = Schema.Literals(["count", "sum"]);
export type EventAggregation = typeof EventAggregation.Type;

/** Built-in event store source: events tracked with the SDK's track(name, value) */
export class EventSource extends Schema.Class<EventSource>("EventSource")({
  event: Schema.String,
  /** count = number of events, sum = sum of event values. Ignored for proportion */
  aggregation: EventAggregation,
}) {}

export class EventMetricDefinition extends Schema.TaggedClass<EventMetricDefinition>()("event", {
  numerator: EventSource,
  /** Required for ratio metrics only */
  denominator: Schema.NullOr(EventSource),
}) {}

/**
 * Warehouse source: SQL returning one row per event with columns
 * user_id (STRING), timestamp (TIMESTAMP), value (FLOAT64; use 1 for counts)
 */
export class SqlMetricDefinition extends Schema.TaggedClass<SqlMetricDefinition>()("sql", {
  numeratorSql: Schema.String,
  /** Required for ratio metrics only */
  denominatorSql: Schema.NullOr(Schema.String),
}) {}

export const MetricDefinition = Schema.Union([EventMetricDefinition, SqlMetricDefinition]);
export type MetricDefinition = typeof MetricDefinition.Type;

/** Winsorization applied to per-user totals, never to raw events */
export const MetricCapping = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("absolute"), value: Schema.Finite }),
  /** value is a quantile in (0, 1), e.g. 0.99. Computed across all variations each analysis */
  Schema.Struct({ type: Schema.Literal("percentile"), value: Schema.Finite }),
]);
export type MetricCapping = typeof MetricCapping.Type;

export class Metric extends Schema.Class<Metric>("Metric")({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  description: Schema.String,
  type: MetricType,
  dataSourceId: Schema.String,
  definition: MetricDefinition,
  /** true when lower values are better (latency, churn) */
  inverse: Schema.Boolean,
  /** Only events within this many hours after first exposure count. null = until analysis time */
  windowHours: Schema.NullOr(Schema.Finite),
  /** Ignore events in the first N hours after exposure */
  delayHours: Schema.Finite,
  capping: MetricCapping,
  archived: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}
