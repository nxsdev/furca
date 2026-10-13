import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.experiments.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const experimentsRouter = {
  list: authed.experiments.list.handler(notImplemented),
  get: authed.experiments.get.handler(notImplemented),
  create: authed.experiments.create.handler(notImplemented),
  update: authed.experiments.update.handler(notImplemented),
  start: authed.experiments.start.handler(notImplemented),
  updateTraffic: authed.experiments.updateTraffic.handler(notImplemented),
  stop: authed.experiments.stop.handler(notImplemented),
  archive: authed.experiments.archive.handler(notImplemented),
  delete: authed.experiments.delete.handler(notImplemented),
};
