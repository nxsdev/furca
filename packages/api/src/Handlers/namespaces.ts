import { NamespaceService } from "@furca/core/experiments/NamespaceService";
import { authed } from "../Runtime/orpc";

export const namespacesRouter = {
  list: authed.namespaces.list.effect(function* () {
    return yield* (yield* NamespaceService).list;
  }),
  create: authed.namespaces.create.effect(function* ({ context }, input) {
    return yield* (yield* NamespaceService).create(input, context.user);
  }),
  update: authed.namespaces.update.effect(function* ({ context }, input) {
    return yield* (yield* NamespaceService).update(input, context.user);
  }),
  delete: authed.namespaces.delete.effect(function* ({ context }, { id }) {
    return yield* (yield* NamespaceService).delete(id, context.user);
  }),
};
