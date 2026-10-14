import { Context, type Effect } from "effect";
import type { EventSource, MetricType } from "../metrics/Metric";
import type { DimensionResult, ResultSnapshot } from "../results/ExperimentResult";
import type { NotFoundError, PersistenceError, ValidationError } from "../shared/errors";

/** Runs experiment analyses (built-in D1 or BigQuery) and stores them as ResultSnapshots */
export interface ExperimentAnalysisServiceShape {
  /**
   * Analyzes the current phase and stores a snapshot. Warehouse / metric problems are stored in the
   * snapshot (status error or MetricResult.error), not failed. ValidationError for drafts
   */
  readonly refresh: (
    experimentId: string,
  ) => Effect.Effect<ResultSnapshot, NotFoundError | ValidationError | PersistenceError>;
  /** Newest snapshot of the current phase, null if never analyzed (or still a draft) */
  readonly latest: (experimentId: string) => Effect.Effect<ResultSnapshot | null, NotFoundError | PersistenceError>;
  /**
   * Current-phase results split by one of `experiment.dimensions`, computed on demand and not stored.
   * Uncorrected (exploratory). Warehouse problems go to DimensionResult.error. ValidationError for
   * drafts and dimensions the experiment does not record
   */
  readonly dimension: (
    experimentId: string,
    dimension: string,
  ) => Effect.Effect<DimensionResult, NotFoundError | ValidationError | PersistenceError>;
}

export class ExperimentAnalysisService extends Context.Service<
  ExperimentAnalysisService,
  ExperimentAnalysisServiceShape
>()("furca/ExperimentAnalysisService") {}

export interface EventNameStat {
  readonly name: string;
  readonly count: number;
  readonly lastSeenAt: Date;
}

export interface EventPropertyStat {
  readonly property: string;
  /** Events in the last 30 days that carry this property */
  readonly count: number;
  /** Up to 10 most frequent values (booleans as "true" / "false") */
  readonly sampleValues: ReadonlyArray<string>;
}

export interface VolumeBucket {
  /** Start of the UTC hour */
  readonly hour: Date;
  /** New (unit, variation) exposures first seen in this hour */
  readonly exposures: number;
  readonly events: number;
}

/** A metric's recent value in the built-in store, to prefill the experiment power planner */
export interface MetricBaseline {
  /** Days of data actually found, at most the requested number */
  readonly days: number;
  /** Users with any event or exposure in the environment over those days */
  readonly users: number;
  readonly dailyUsers: number;
  /** proportion: share of those users with a matching event; null for mean metrics */
  readonly rate: number | null;
  /** mean: per-user count / sum of matching events (0 for users without one); null for proportion */
  readonly mean: number | null;
  readonly stdDev: number | null;
}

/** Built-in event store statistics for the metric builder and the overview page */
export interface EventStatsServiceShape {
  /** Distinct event names of the last 30 days, most frequent first (max 200) */
  readonly names: (environmentId: string) => Effect.Effect<ReadonlyArray<EventNameStat>, PersistenceError>;
  /** Property keys of one event over the last 30 days, most common first (max 50) */
  readonly properties: (
    environmentId: string,
    event: string,
  ) => Effect.Effect<ReadonlyArray<EventPropertyStat>, PersistenceError>;
  /** 24 hourly buckets ending with the current hour, empty hours included */
  readonly volume: (environmentId: string) => Effect.Effect<ReadonlyArray<VolumeBucket>, PersistenceError>;
  /** Baseline of a proportion / mean event metric over the last `days` (1–90); null without any users */
  readonly baseline: (
    environmentId: string,
    metric: { readonly type: Exclude<MetricType, "ratio">; readonly source: EventSource },
    days: number,
  ) => Effect.Effect<MetricBaseline | null, PersistenceError>;
}

export class EventStatsService extends Context.Service<EventStatsService, EventStatsServiceShape>()(
  "furca/EventStatsService",
) {}
