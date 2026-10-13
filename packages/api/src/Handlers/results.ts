import { ExperimentAnalysisService } from "@kuji/core/analysis/Analysis";
import { authed } from "../Runtime/orpc";

export const resultsRouter = {
  latest: authed.results.latest.effect(function* (_opts, { experimentId }) {
    return yield* (yield* ExperimentAnalysisService).latest(experimentId);
  }),
  refresh: authed.results.refresh.effect(function* (_opts, { experimentId }) {
    return yield* (yield* ExperimentAnalysisService).refresh(experimentId);
  }),
};
