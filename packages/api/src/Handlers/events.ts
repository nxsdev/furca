import { EventStatsService } from "@furca/core/analysis/Analysis";
import { authed } from "../Runtime/orpc";

export const eventsRouter = {
  names: authed.events.names.effect(function* (_opts, { environmentId }) {
    return yield* (yield* EventStatsService).names(environmentId);
  }),
  volume: authed.events.volume.effect(function* (_opts, { environmentId }) {
    return yield* (yield* EventStatsService).volume(environmentId);
  }),
};
