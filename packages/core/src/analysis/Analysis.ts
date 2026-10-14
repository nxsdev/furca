import { Context, type Effect } from "effect";
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
}

export class EventStatsService extends Context.Service<EventStatsService, EventStatsServiceShape>()(
  "furca/EventStatsService",
) {}
