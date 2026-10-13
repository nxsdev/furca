import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.features.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const featuresRouter = {
  list: authed.features.list.handler(notImplemented),
  get: authed.features.get.handler(notImplemented),
  create: authed.features.create.handler(notImplemented),
  update: authed.features.update.handler(notImplemented),
  setEnabled: authed.features.setEnabled.handler(notImplemented),
  saveRules: authed.features.saveRules.handler(notImplemented),
  archive: authed.features.archive.handler(notImplemented),
  delete: authed.features.delete.handler(notImplemented),
};
