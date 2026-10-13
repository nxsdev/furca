import { EventStatsServiceLive } from "@furca/persistence/Layers/EventStatsServiceLive";
import { ExperimentAnalysisServiceLive } from "@furca/persistence/Layers/ExperimentAnalysisServiceLive";
import { WarehouseTesterLive } from "@furca/persistence/Layers/WarehouseTesterLive";
import { Layer } from "effect";

/**
 * Experiment analysis (built-in D1 + BigQuery), event stats and connection tests.
 * Owned by the analysis implementation; must only require BaseServices
 */
export const AnalysisServicesLive = Layer.mergeAll(ExperimentAnalysisServiceLive, EventStatsServiceLive, WarehouseTesterLive);
