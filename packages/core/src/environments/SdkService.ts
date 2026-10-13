import { Context, type Effect } from "effect";
import type { NotFoundError, PersistenceError } from "../shared/errors";

/** Validated SDK events request (see EventsBody in @furca/sdk) */
export interface IngestBatch {
  readonly exposures: ReadonlyArray<{
    readonly experimentKey: string;
    readonly variationKey: string;
    /** Experiment phase index the SDK evaluated */
    readonly phase: number;
    readonly userId: string;
    readonly ts: number;
  }>;
  readonly events: ReadonlyArray<{ readonly name: string; readonly userId: string; readonly value: number | null; readonly ts: number }>;
}

/** Public SDK endpoints. NotFoundError = unknown SDK key */
export interface SdkServiceShape {
  /** Published payload JSON; built and published on a store miss */
  readonly payload: (sdkKey: string) => Effect.Effect<string, NotFoundError | PersistenceError>;
  /**
   * Stores exposures (first time seen per unit x experiment x phase x variation) and events. Items outside
   * [now - 7 days, now + 1 hour] or without a user id are dropped. Returns the number accepted
   */
  readonly ingest: (sdkKey: string, batch: IngestBatch) => Effect.Effect<number, NotFoundError | PersistenceError>;
}

export class SdkService extends Context.Service<SdkService, SdkServiceShape>()("furca/SdkService") {}
