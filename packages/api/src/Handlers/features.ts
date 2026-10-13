import { FeatureService } from "@furca/core/features/FeatureService";
import { authed } from "../Runtime/orpc";

export const featuresRouter = {
  list: authed.features.list.effect(function* (_opts, { includeArchived }) {
    return yield* (yield* FeatureService).list(includeArchived);
  }),
  get: authed.features.get.effect(function* (_opts, { id }) {
    return yield* (yield* FeatureService).get(id);
  }),
  create: authed.features.create.effect(function* ({ context }, input) {
    return yield* (yield* FeatureService).create(input, context.user);
  }),
  update: authed.features.update.effect(function* ({ context }, input) {
    return yield* (yield* FeatureService).update(input, context.user);
  }),
  setEnabled: authed.features.setEnabled.effect(function* ({ context }, input) {
    return yield* (yield* FeatureService).setEnabled(input, context.user);
  }),
  saveRules: authed.features.saveRules.effect(function* ({ context }, input) {
    return yield* (yield* FeatureService).saveRules(input, context.user);
  }),
  archive: authed.features.archive.effect(function* ({ context }, input) {
    return yield* (yield* FeatureService).archive(input, context.user);
  }),
  delete: authed.features.delete.effect(function* ({ context }, { id }) {
    yield* (yield* FeatureService)
      .delete(id, context.user);
  }),
};
