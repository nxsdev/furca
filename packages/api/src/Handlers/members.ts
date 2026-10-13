import { MemberService } from "@furca/core/members/MemberService";
import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { authed } from "../Runtime/orpc";

export const membersRouter = {
  list: authed.members.list.effect(function* () {
    return yield* (yield* MemberService).list;
  }),
  invite: authed.members.invite.effect(function* ({ context }, { email }) {
    return yield* (yield* MemberService).invite(email, context.user);
  }),
  revokeInvitation: authed.members.revokeInvitation.effect(function* ({ context }, { id }) {
    yield* (yield* MemberService).revokeInvitation(id, context.user);
  }),
  remove: authed.members.remove.effect(function* ({ context }, { id }) {
    if (!context.user.isOwner) {
      return yield* Effect.fail(new ORPCError("FORBIDDEN", { message: "Only the owner can remove members" }));
    }
    if (id === context.user.id) return yield* Effect.fail(new ORPCError("FORBIDDEN", { message: "The owner cannot be removed" }));
    yield* (yield* MemberService).remove(id, context.user);
  }),
};
