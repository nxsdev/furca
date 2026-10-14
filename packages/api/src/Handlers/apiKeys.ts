import { ApiKeyService } from "@furca/core/platform/ApiKeyService";
import { authed } from "../Runtime/orpc";

export const apiKeysRouter = {
  list: authed.apiKeys.list.effect(function* () {
    return yield* (yield* ApiKeyService).list;
  }),
  create: authed.apiKeys.create.effect(function* ({ context }, input) {
    return yield* (yield* ApiKeyService).create(input, context.user);
  }),
  revoke: authed.apiKeys.revoke.effect(function* ({ context }, { id }) {
    return yield* (yield* ApiKeyService).revoke(id, context.user);
  }),
};
