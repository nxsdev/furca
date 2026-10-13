import { ORPCError } from "@orpc/server";
import { authed } from "../Runtime/orpc";

// TODO: replace stubs with Effect handlers (`authed.members.<proc>.effect(function* (opts, input) { ... })`)
const notImplemented = () => {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Not implemented yet" });
};

export const membersRouter = {
  list: authed.members.list.handler(notImplemented),
  invite: authed.members.invite.handler(notImplemented),
  revokeInvitation: authed.members.revokeInvitation.handler(notImplemented),
  remove: authed.members.remove.handler(notImplemented),
};
