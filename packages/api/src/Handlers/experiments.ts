import { ExperimentService } from "@furca/core/experiments/ExperimentService";
import { authed } from "../Runtime/orpc";

export const experimentsRouter = {
  list: authed.experiments.list.effect(function* (_opts, { includeArchived }) {
    return yield* (yield* ExperimentService).list(includeArchived);
  }),
  get: authed.experiments.get.effect(function* (_opts, { id }) {
    return yield* (yield* ExperimentService).get(id);
  }),
  create: authed.experiments.create.effect(function* ({ context }, input) {
    return yield* (yield* ExperimentService).create(input, context.user);
  }),
  update: authed.experiments.update.effect(function* ({ context }, input) {
    return yield* (yield* ExperimentService).update(input, context.user);
  }),
  start: authed.experiments.start.effect(function* ({ context }, { id }) {
    return yield* (yield* ExperimentService).start(id, context.user);
  }),
  updateTraffic: authed.experiments.updateTraffic.effect(function* ({ context }, input) {
    return yield* (yield* ExperimentService).updateTraffic(input, context.user);
  }),
  stop: authed.experiments.stop.effect(function* ({ context }, input) {
    return yield* (yield* ExperimentService).stop(input, context.user);
  }),
  archive: authed.experiments.archive.effect(function* ({ context }, input) {
    return yield* (yield* ExperimentService).archive(input, context.user);
  }),
  delete: authed.experiments.delete.effect(function* ({ context }, { id }) {
    yield* (yield* ExperimentService).delete(id, context.user);
  }),
};
