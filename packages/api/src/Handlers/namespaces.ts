import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const namespacesRouter = {
  list: authed.namespaces.list.handler(notImplemented),
  create: authed.namespaces.create.handler(notImplemented),
  update: authed.namespaces.update.handler(notImplemented),
  delete: authed.namespaces.delete.handler(notImplemented),
};
