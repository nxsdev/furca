import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { SavedGroup } from "./SavedGroup";

export type SavedGroupInput = Pick<SavedGroup, "name" | "description" | "type" | "conditions" | "attribute" | "values">;

type Errors = NotFoundError | ValidationError | PersistenceError;

/** Reusable audiences. Every mutation is audited; updates republish payloads */
export interface SavedGroupServiceShape {
  /** By name */
  readonly list: Effect.Effect<ReadonlyArray<SavedGroup>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<SavedGroup, NotFoundError | PersistenceError>;
  readonly create: (input: SavedGroupInput & { readonly key: string }, actor: Actor) => Effect.Effect<SavedGroup, Errors>;
  readonly update: (input: SavedGroupInput & { readonly id: string }, actor: Actor) => Effect.Effect<SavedGroup, Errors>;
  /** ConflictError while a flag rule, a draft / running experiment or another group references it */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors | ConflictError>;
}

export class SavedGroupService extends Context.Service<SavedGroupService, SavedGroupServiceShape>()("furca/SavedGroupService") {}
