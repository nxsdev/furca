import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { ExperimentStatus } from "./Experiment";
import type { Namespace } from "./Namespace";

/** A namespace with the slices its draft and running experiments hold, in start order */
export interface NamespaceWithAllocations {
  readonly namespace: Namespace;
  readonly allocations: ReadonlyArray<{
    readonly experimentId: string;
    readonly experimentName: string;
    readonly status: ExperimentStatus;
    readonly start: number;
    readonly end: number;
  }>;
}

type Errors = NotFoundError | ValidationError | PersistenceError;
type Fields = { readonly name: string; readonly description: string };

/** Mutual-exclusion namespaces. Every mutation is audited */
export interface NamespaceServiceShape {
  /** By name */
  readonly list: Effect.Effect<ReadonlyArray<NamespaceWithAllocations>, PersistenceError>;
  readonly create: (input: Fields & { readonly key: string }, actor: Actor) => Effect.Effect<Namespace, Errors>;
  readonly update: (input: Fields & { readonly id: string }, actor: Actor) => Effect.Effect<Namespace, Errors>;
  /** ConflictError while a draft or running experiment holds a slice */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors | ConflictError>;
}

export class NamespaceService extends Context.Service<NamespaceService, NamespaceServiceShape>()("furca/NamespaceService") {}
