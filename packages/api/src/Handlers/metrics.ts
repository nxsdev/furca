import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.metrics.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const metricsRouter = {
  list: authed.metrics.list.handler(notImplemented),
  get: authed.metrics.get.handler(notImplemented),
  create: authed.metrics.create.handler(notImplemented),
  update: authed.metrics.update.handler(notImplemented),
  archive: authed.metrics.archive.handler(notImplemented),
};
