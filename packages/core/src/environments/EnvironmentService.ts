import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { Environment } from "./Environment";

export interface EnvironmentSummary {
  readonly environment: Environment;
  /** Byte size of the published payload, null if never published */
  readonly payloadBytes: number | null;
  /** Non-archived features enabled in this environment */
  readonly featureCount: number;
}

type Errors = NotFoundError | ValidationError | PersistenceError;

export interface EnvironmentServiceShape {
  readonly list: Effect.Effect<ReadonlyArray<EnvironmentSummary>, PersistenceError>;
  /** New random SDK key; every existing feature gets a disabled row */
  readonly create: (input: { readonly key: string; readonly name: string }, actor: Actor) => Effect.Effect<Environment, Errors>;
  readonly update: (input: { readonly id: string; readonly name: string }, actor: Actor) => Effect.Effect<Environment, Errors>;
  readonly setRequireApproval: (
    input: { readonly id: string; readonly requireApproval: boolean },
    actor: Actor,
  ) => Effect.Effect<Environment, Errors>;
  /** Publishes under the new key and removes the old one */
  readonly rotateSdkKey: (id: string, actor: Actor) => Effect.Effect<Environment, Errors>;
  /** ConflictError for the last environment or one a running experiment uses */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors | ConflictError>;
  /** The payload SDKs receive, freshly built and pretty-printed */
  readonly payload: (id: string) => Effect.Effect<string, Errors>;
}

export class EnvironmentService extends Context.Service<EnvironmentService, EnvironmentServiceShape>()(
  "furca/EnvironmentService",
) {}
