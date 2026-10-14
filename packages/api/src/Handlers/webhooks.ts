import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const webhooksRouter = {
  list: authed.webhooks.list.handler(notImplemented),
  create: authed.webhooks.create.handler(notImplemented),
  update: authed.webhooks.update.handler(notImplemented),
  delete: authed.webhooks.delete.handler(notImplemented),
  test: authed.webhooks.test.handler(notImplemented),
};
