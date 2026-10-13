import { Context, type Effect } from "effect";
import type { PersistenceError } from "../shared/errors";

/** Where SDK payloads are published (Cloudflare KV in production). Keyed by SDK key */
export interface PayloadStoreShape {
  readonly put: (sdkKey: string, json: string) => Effect.Effect<void, PersistenceError>;
  readonly get: (sdkKey: string) => Effect.Effect<string | null, PersistenceError>;
  readonly remove: (sdkKey: string) => Effect.Effect<void, PersistenceError>;
}

export class PayloadStore extends Context.Service<PayloadStore, PayloadStoreShape>()("furca/PayloadStore") {}
