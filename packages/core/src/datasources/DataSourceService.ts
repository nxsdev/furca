import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { ConflictError, NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { BigQueryConfig, DataSource } from "./DataSource";

type Errors = NotFoundError | ValidationError | PersistenceError;

/** Data sources. Credentials are encrypted with CredentialCipher and never returned */
export interface DataSourceServiceShape {
  readonly list: Effect.Effect<ReadonlyArray<DataSource>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<DataSource, NotFoundError | PersistenceError>;
  /** credentialsJson: service account key JSON (needs client_email and private_key) */
  readonly createBigQuery: (
    input: { readonly name: string; readonly bigquery: BigQueryConfig; readonly credentialsJson: string; readonly exposureSql: string },
    actor: Actor,
  ) => Effect.Effect<DataSource, Errors>;
  /** credentialsJson null keeps the stored credentials. The builtin source only takes a new name */
  readonly update: (
    input: {
      readonly id: string;
      readonly name: string;
      readonly bigquery: BigQueryConfig | null;
      readonly credentialsJson: string | null;
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
