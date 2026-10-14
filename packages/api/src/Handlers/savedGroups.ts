import { SavedGroupService } from "@furca/core/targeting/SavedGroupService";
import { authed } from "../Runtime/orpc";

export const savedGroupsRouter = {
  list: authed.savedGroups.list.effect(function* () {
    return yield* (yield* SavedGroupService).list;
  }),
  get: authed.savedGroups.get.effect(function* (_opts, { id }) {
    return yield* (yield* SavedGroupService).get(id);
  }),
  create: authed.savedGroups.create.effect(function* ({ context }, input) {
    return yield* (yield* SavedGroupService).create(input, context.user);
  }),
  update: authed.savedGroups.update.effect(function* ({ context }, input) {
    return yield* (yield* SavedGroupService).update(input, context.user);
  }),
  delete: authed.savedGroups.delete.effect(function* ({ context }, { id }) {
    return yield* (yield* SavedGroupService).delete(id, context.user);
  }),
};
