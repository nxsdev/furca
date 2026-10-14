import { WebhookService } from "@furca/core/platform/WebhookService";
import { authed } from "../Runtime/orpc";

export const webhooksRouter = {
  list: authed.webhooks.list.effect(function* () {
    return yield* (yield* WebhookService).list;
  }),
  create: authed.webhooks.create.effect(function* ({ context }, input) {
    return yield* (yield* WebhookService).create(input, context.user);
  }),
  update: authed.webhooks.update.effect(function* ({ context }, input) {
    return yield* (yield* WebhookService).update(input, context.user);
  }),
  delete: authed.webhooks.delete.effect(function* ({ context }, { id }) {
    yield* (yield* WebhookService).delete(id, context.user);
  }),
  test: authed.webhooks.test.effect(function* (_opts, { id }) {
    return yield* (yield* WebhookService).test(id);
  }),
};
