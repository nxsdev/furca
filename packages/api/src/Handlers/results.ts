import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.results.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const resultsRouter = {
  latest: authed.results.latest.handler(notImplemented),
  refresh: authed.results.refresh.handler(notImplemented),
};
