import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { ApiKey, ApiKeyRole } from "./ApiKey";

/** REST API keys. Only a SHA-256 of each secret is stored */
export interface ApiKeyServiceShape {
  /** Newest first, revoked keys included */
  readonly list: Effect.Effect<ReadonlyArray<ApiKey>, PersistenceError>;
  /** `secret` (`furca_…`) is returned here and never again */
  readonly create: (
    input: { readonly name: string; readonly role: ApiKeyRole },
    actor: Actor,
  ) => Effect.Effect<{ readonly apiKey: ApiKey; readonly secret: string }, ValidationError | PersistenceError>;
  /** Idempotent: revoking a revoked key returns it unchanged */
  readonly revoke: (id: string, actor: Actor) => Effect.Effect<ApiKey, NotFoundError | PersistenceError>;
  /** The non-revoked key for a presented secret, or null. Records lastUsedAt at most once a minute */
  readonly authenticate: (secret: string) => Effect.Effect<ApiKey | null, PersistenceError>;
}

export class ApiKeyService extends Context.Service<ApiKeyService, ApiKeyServiceShape>()("furca/ApiKeyService") {}
