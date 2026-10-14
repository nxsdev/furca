import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, ForbiddenError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { ChangeRequest, ChangeRequestStatus, FlagChange } from "./ChangeRequest";

type Review = { readonly id: string; readonly comment: string };

/**
 * Reviewed flag changes (on/off and rules of one environment) and experiment actions (start,
 * traffic, stop) of experiments running in an environment that requires approval. Every transition
 * is audited on the flag. Role checks (admins review; author or admin cancels) belong to the API layer
 */
export interface ChangeRequestServiceShape {
  /** Newest first */
  readonly list: (filter: {
    readonly status: ChangeRequestStatus | null;
    readonly featureId: string | null;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<ChangeRequest, NotFoundError | PersistenceError>;
  /**
   * Records the environment's current state as the base. ValidationError for invalid rules, no
   * change, or an experiment action that isn't possible now (e.g. starting a running experiment);
   * ConflictError when the experiment already has an open request
   */
  readonly create: (
    input: { readonly featureId: string; readonly environmentId: string; readonly change: FlagChange; readonly comment: string },
    actor: Actor,
  ) => Effect.Effect<ChangeRequest, NotFoundError | ValidationError | ConflictError | PersistenceError>;
  /**
   * Applies the change in one batch, republishes and emits `flag.updated` (experiment actions: the
   * experiment's event). ForbiddenError for the author, unless nobody else is an admin: then the
   * comment must give a reason and the approval is audited as `review.selfApproved`.
   * ConflictError when the request is closed or the flag (experiment) changed since it was opened
   */
  readonly approve: (
    input: Review,
    actor: Actor,
  ) => Effect.Effect<ChangeRequest, NotFoundError | ValidationError | ForbiddenError | ConflictError | PersistenceError>;
  readonly reject: (input: Review, actor: Actor) => Effect.Effect<ChangeRequest, NotFoundError | ConflictError | PersistenceError>;
  readonly cancel: (id: string, actor: Actor) => Effect.Effect<ChangeRequest, NotFoundError | ConflictError | PersistenceError>;
}

export class ChangeRequestService extends Context.Service<ChangeRequestService, ChangeRequestServiceShape>()(
  "furca/ChangeRequestService",
) {}
