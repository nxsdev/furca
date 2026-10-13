import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { Invitation, Member } from "./Member";

/** Members and invitations. Permission checks (owner only) belong to the caller */
export interface MemberServiceShape {
  /** Users (owner = earliest) and pending, unexpired invitations */
  readonly list: Effect.Effect<
    { readonly members: ReadonlyArray<Member>; readonly invitations: ReadonlyArray<Invitation> },
    PersistenceError
  >;
  /** 7-day one-time link; replaces a pending invitation for the same email */
  readonly invite: (email: string, actor: Actor) => Effect.Effect<Invitation, ValidationError | PersistenceError>;
  readonly revokeInvitation: (id: string, actor: Actor) => Effect.Effect<void, NotFoundError | PersistenceError>;
  /** Deletes the user with their sessions and accounts */
  readonly remove: (id: string, actor: Actor) => Effect.Effect<void, NotFoundError | PersistenceError>;
}

export class MemberService extends Context.Service<MemberService, MemberServiceShape>()("kuji/MemberService") {}
