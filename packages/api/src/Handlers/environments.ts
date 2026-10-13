import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.environments.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const environmentsRouter = {
  list: authed.environments.list.handler(notImplemented),
  create: authed.environments.create.handler(notImplemented),
  update: authed.environments.update.handler(notImplemented),
  rotateSdkKey: authed.environments.rotateSdkKey.handler(notImplemented),
  delete: authed.environments.delete.handler(notImplemented),
  payload: authed.environments.payload.handler(notImplemented),
};
