import { ChangeRequestService } from "@furca/core/approvals/ChangeRequestService";
import { hasRole } from "@furca/core/members/Member";
import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { authed } from "../Runtime/orpc";

export const changeRequestsRouter = {
  list: authed.changeRequests.list.effect(function* (_opts, input) {
    return yield* (yield* ChangeRequestService).list({ status: input.status ?? null, featureId: input.featureId ?? null });
  }),
  get: authed.changeRequests.get.effect(function* (_opts, { id }) {
    return yield* (yield* ChangeRequestService).get(id);
  }),
  create: authed.changeRequests.create.effect(function* ({ context }, input) {
    return yield* (yield* ChangeRequestService).create(input, context.user);
  }),
  approve: authed.changeRequests.approve.effect(function* ({ context }, input) {
    return yield* (yield* ChangeRequestService).approve(input, context.user);
  }),
  reject: authed.changeRequests.reject.effect(function* ({ context }, input) {
    return yield* (yield* ChangeRequestService).reject(input, context.user);
  }),
  cancel: authed.changeRequests.cancel.effect(function* ({ context }, { id }) {
    const service = yield* ChangeRequestService;
    const request = yield* service.get(id);
    if (request.authorId !== context.user.id && !hasRole(context.user.role, "admin")) {
      return yield* Effect.fail(new ORPCError("FORBIDDEN", { message: "Only the author or an admin can cancel this request" }));
    }
    return yield* service.cancel(id, context.user);
  }),
};
