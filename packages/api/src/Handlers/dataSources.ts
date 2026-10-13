import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.dataSources.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const dataSourcesRouter = {
  list: authed.dataSources.list.handler(notImplemented),
  get: authed.dataSources.get.handler(notImplemented),
  createBigQuery: authed.dataSources.createBigQuery.handler(notImplemented),
  update: authed.dataSources.update.handler(notImplemented),
  delete: authed.dataSources.delete.handler(notImplemented),
  test: authed.dataSources.test.handler(notImplemented),
};
