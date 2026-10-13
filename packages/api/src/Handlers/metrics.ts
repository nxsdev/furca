import { MetricService } from "@kuji/core/metrics/MetricService";
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
};
