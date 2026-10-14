import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const savedGroupsRouter = {
  list: authed.savedGroups.list.handler(notImplemented),
  get: authed.savedGroups.get.handler(notImplemented),
  create: authed.savedGroups.create.handler(notImplemented),
  update: authed.savedGroups.update.handler(notImplemented),
  delete: authed.savedGroups.delete.handler(notImplemented),
};
