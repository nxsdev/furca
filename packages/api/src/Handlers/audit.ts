import { AuditService } from "@furca/core/audit/AuditService";
import { authed } from "../Runtime/orpc";

export const auditRouter = {
  list: authed.audit.list.effect(function* (_opts, input) {
    return yield* (yield* AuditService).list(input);
  }),
};
