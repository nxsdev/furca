import { ExperimentAnalysisService } from "@furca/core/analysis/Analysis";
import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

export const resultsRouter = {
  latest: authed.results.latest.effect(function* (_opts, { experimentId }) {
    return yield* (yield* ExperimentAnalysisService).latest(experimentId);
  }),
  refresh: authed.results.refresh.effect(function* (_opts, { experimentId }) {
    return yield* (yield* ExperimentAnalysisService).refresh(experimentId);
  }),
  // TODO(analytics): dimension breakdowns
  dimension: authed.results.dimension.handler(() => {
    throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
  }),
};
