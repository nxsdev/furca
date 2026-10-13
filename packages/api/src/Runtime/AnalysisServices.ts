import { Layer } from "effect";

/**
 * Experiment analysis (built-in D1 + BigQuery), event stats and connection tests.
 * Owned by the analysis implementation; must only require BaseServices
 */
export const AnalysisServicesLive = Layer.empty;
