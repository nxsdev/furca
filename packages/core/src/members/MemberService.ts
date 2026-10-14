import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, ForbiddenError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { AssignableRole, Invitation, Member } from "./Member";

/** Members and invitations. Role checks of the caller (admin only) belong to the API layer */
export interface MemberServiceShape {
  /** Users (owner first) and pending, unexpired invitations */
  readonly list: Effect.Effect<
    { readonly members: ReadonlyArray<Member>; readonly invitations: ReadonlyArray<Invitation> },
    PersistenceError
  >;
  /** 7-day one-time link; replaces a pending invitation for the same email */
  readonly invite: (email: string, role: AssignableRole, actor: Actor) => Effect.Effect<Invitation, ValidationError | PersistenceError>;
  readonly revokeInvitation: (id: string, actor: Actor) => Effect.Effect<void, NotFoundError | PersistenceError>;
  /**
   * ForbiddenError for the owner (immutable); ConflictError when it would demote the last
   * owner/admin
   */
  readonly setRole: (
    id: string,
    role: AssignableRole,
    actor: Actor,
  ) => Effect.Effect<Member, NotFoundError | ForbiddenError | ConflictError | PersistenceError>;
  /** Deletes the user with their sessions and accounts. ForbiddenError for the owner */
  readonly remove: (id: string, actor: Actor) => Effect.Effect<void, NotFoundError | ForbiddenError | PersistenceError>;
}

export class MemberService extends Context.Service<MemberService, MemberServiceShape>()("furca/MemberService") {}
