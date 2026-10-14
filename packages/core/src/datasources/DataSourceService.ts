import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { DataSource, WarehouseConfig } from "./DataSource";

type Errors = NotFoundError | ValidationError | PersistenceError;

/** Data sources. Credentials are encrypted with CredentialCipher and never returned */
export interface DataSourceServiceShape {
  readonly list: Effect.Effect<ReadonlyArray<DataSource>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<DataSource, NotFoundError | PersistenceError>;
  /**
   * The warehouse type is config._tag. credentials: BigQuery service account key JSON, Snowflake
   * PKCS#8 private key PEM, ClickHouse / Postgres password
   */
  readonly create: (
    input: { readonly name: string; readonly config: WarehouseConfig; readonly credentials: string; readonly exposureSql: string },
    actor: Actor,
  ) => Effect.Effect<DataSource, Errors>;
  /** credentials null keeps the stored ones. The type cannot change. The builtin source only takes a new name */
  readonly update: (
    input: {
      readonly id: string;
      readonly name: string;
      readonly config: WarehouseConfig | null;
      readonly credentials: string | null;
      readonly exposureSql: string;
    },
    actor: Actor,
  ) => Effect.Effect<DataSource, Errors>;
  /** ConflictError for the builtin source or one used by metrics / experiments */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors | ConflictError>;
}

export class DataSourceService extends Context.Service<DataSourceService, DataSourceServiceShape>()(
  "furca/DataSourceService",
) {}
