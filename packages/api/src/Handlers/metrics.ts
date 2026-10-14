import { EventStatsService } from "@furca/core/analysis/Analysis";
import { MetricService } from "@furca/core/metrics/MetricService";
import { authed } from "../Runtime/orpc";

export const metricsRouter = {
  list: authed.metrics.list.effect(function* (_opts, { includeArchived }) {
    return yield* (yield* MetricService).list(includeArchived);
  }),
  get: authed.metrics.get.effect(function* (_opts, { id }) {
    return yield* (yield* MetricService).get(id);
  }),
  create: authed.metrics.create.effect(function* ({ context }, input) {
    return yield* (yield* MetricService).create(input, context.user);
  }),
  update: authed.metrics.update.effect(function* ({ context }, input) {
    return yield* (yield* MetricService).update(input, context.user);
  }),
  archive: authed.metrics.archive.effect(function* ({ context }, input) {
    return yield* (yield* MetricService).archive(input, context.user);
  }),
  baseline: authed.metrics.baseline.effect(function* (_opts, { metricId, environmentId, days }) {
    const metric = yield* (yield* MetricService).get(metricId);
    // Warehouse metrics keep manual input: querying a warehouse on every planner open costs money
    if (metric.definition._tag !== "event" || metric.type === "ratio") return null;
    return yield* (yield* EventStatsService).baseline(environmentId, { type: metric.type, source: metric.definition.numerator }, days);
  }),
};
