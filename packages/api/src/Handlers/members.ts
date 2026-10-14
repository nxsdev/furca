import { hasRole } from "@furca/core/members/Member";
import { MemberService } from "@furca/core/members/MemberService";
import { authed } from "../Runtime/orpc";

export const membersRouter = {
  list: authed.members.list.effect(function* ({ context }) {
    const list = yield* (yield* MemberService).list;
    // Invitation links let anyone with the invited email sign up with its role: admins only
    return hasRole(context.user.role, "admin") ? list : { ...list, invitations: [] };
  }),
  invite: authed.members.invite.effect(function* ({ context }, { email, role }) {
    return yield* (yield* MemberService).invite(email, role, context.user);
  }),
  revokeInvitation: authed.members.revokeInvitation.effect(function* ({ context }, { id }) {
    yield* (yield* MemberService).revokeInvitation(id, context.user);
  }),
  setRole: authed.members.setRole.effect(function* ({ context }, { id, role }) {
    return yield* (yield* MemberService).setRole(id, role, context.user);
  }),
  remove: authed.members.remove.effect(function* ({ context }, { id }) {
    yield* (yield* MemberService).remove(id, context.user);
  }),
};
