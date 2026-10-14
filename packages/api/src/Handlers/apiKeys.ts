import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const apiKeysRouter = {
  list: authed.apiKeys.list.handler(notImplemented),
  create: authed.apiKeys.create.handler(notImplemented),
  revoke: authed.apiKeys.revoke.handler(notImplemented),
};
