import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, ForbiddenError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { Feature, FeatureRule } from "./Feature";

type Errors = NotFoundError | ValidationError | PersistenceError;
type Id = { readonly id: string };

/** Feature flags. Every mutation is audited; changes that affect payloads republish them */
export interface FeatureServiceShape {
  readonly list: (includeArchived: boolean) => Effect.Effect<ReadonlyArray<Feature>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<Feature, NotFoundError | PersistenceError>;
  /** Disabled in every environment, no rules */
  readonly create: (
    input: Pick<Feature, "key" | "description" | "valueType" | "defaultValue" | "tags">,
    actor: Actor,
  ) => Effect.Effect<Feature, Errors>;
  readonly update: (input: Id & Pick<Feature, "description" | "defaultValue" | "tags">, actor: Actor) => Effect.Effect<Feature, Errors>;
  /** ForbiddenError where the environment requires a review (use a change request) */
  readonly setEnabled: (
    input: Id & { readonly environmentId: string; readonly enabled: boolean },
    actor: Actor,
  ) => Effect.Effect<Feature, Errors | ForbiddenError>;
  /** Experiment rules may be reordered or toggled, never added or removed. ForbiddenError like setEnabled */
  readonly saveRules: (
    input: Id & { readonly environmentId: string; readonly rules: ReadonlyArray<FeatureRule> },
    actor: Actor,
  ) => Effect.Effect<Feature, Errors | ForbiddenError>;
  readonly archive: (input: Id & { readonly archived: boolean }, actor: Actor) => Effect.Effect<Feature, Errors>;
  /** ConflictError when experiments reference the feature */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors | ConflictError>;
}

export class FeatureService extends Context.Service<FeatureService, FeatureServiceShape>()("furca/FeatureService") {}
