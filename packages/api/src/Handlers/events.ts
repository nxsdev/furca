import { EventStatsService } from "@furca/core/analysis/Analysis";
import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

export const eventsRouter = {
  names: authed.events.names.effect(function* (_opts, { environmentId }) {
    return yield* (yield* EventStatsService).names(environmentId);
  }),
  volume: authed.events.volume.effect(function* (_opts, { environmentId }) {
    return yield* (yield* EventStatsService).volume(environmentId);
  }),
  // TODO(analytics): property keys for metric filters
  properties: authed.events.properties.handler(() => {
    throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
  }),
};
