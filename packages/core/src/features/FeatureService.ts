import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
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
  readonly setEnabled: (
    input: Id & { readonly environmentId: string; readonly enabled: boolean },
    actor: Actor,
  ) => Effect.Effect<Feature, Errors>;
  /** Experiment rules may be reordered or toggled, never added or removed */
  readonly saveRules: (
    input: Id & { readonly environmentId: string; readonly rules: ReadonlyArray<FeatureRule> },
    actor: Actor,
  ) => Effect.Effect<Feature, Errors>;
  readonly archive: (input: Id & { readonly archived: boolean }, actor: Actor) => Effect.Effect<Feature, Errors>;
  /** ConflictError when experiments reference the feature */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors | ConflictError>;
}

export class FeatureService extends Context.Service<FeatureService, FeatureServiceShape>()("kuji/FeatureService") {}
