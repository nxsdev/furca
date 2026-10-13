import { EventStatsServiceLive } from "@kuji/persistence/Layers/EventStatsServiceLive";
import { ExperimentAnalysisServiceLive } from "@kuji/persistence/Layers/ExperimentAnalysisServiceLive";
import { WarehouseTesterLive } from "@kuji/persistence/Layers/WarehouseTesterLive";
import { Layer } from "effect";

/**
 * Experiment analysis (built-in D1 + BigQuery), event stats and connection tests.
 * Owned by the analysis implementation; must only require BaseServices
 */
export const AnalysisServicesLive = Layer.mergeAll(ExperimentAnalysisServiceLive, EventStatsServiceLive, WarehouseTesterLive);
