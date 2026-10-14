/** One interface over every warehouse client, picked by the data source's config */
import type { WarehouseConfig, WarehouseType } from "@furca/core/datasources/DataSource";
import type { WarehouseError } from "@furca/core/shared/errors";
import { Effect } from "effect";
import * as BigQuery from "./bigquery/client";
import * as ClickHouse from "./clickhouse/client";
import * as Postgres from "./postgres/client";
import type { QueryParams, Row } from "./shared";
import * as Snowflake from "./snowflake/client";

export type { QueryParams, Row } from "./shared";

export interface Warehouse {
  readonly type: WarehouseType;
  /** Who furca authenticates as, for messages */
  readonly identity: string;
  /** Runs SQL with `@name` parameters */
  readonly query: (sql: string, params: QueryParams) => Effect.Effect<ReadonlyArray<Row>, WarehouseError>;
  /**
   * Authenticates and compiles SQL without reading data: a free BigQuery dry run (returns the bytes
   * it would scan), elsewhere the query with LIMIT 0 (returns null)
   */
  readonly check: (sql: string, params: QueryParams) => Effect.Effect<number | null, WarehouseError>;
}

/** credentials: the decrypted secret stored for the source (key JSON, private key PEM or password) */
export const connect = (config: WarehouseConfig, credentials: string): Effect.Effect<Warehouse, WarehouseError> => {
  const limitZero = (query: Warehouse["query"]): Warehouse["check"] => (sql, params) =>
    query(`${sql}\nLIMIT 0`, params).pipe(Effect.as(null));
  const make = (identity: string, query: Warehouse["query"], check = limitZero(query)): Warehouse => ({ type: config._tag, identity, query, check });
  switch (config._tag) {
    case "bigquery":
      return BigQuery.parseServiceAccount(credentials).pipe(
        Effect.map((sa) =>
          make(
            sa.client_email,
            (sql, params) => BigQuery.query(sa, config, sql, params),
            (sql, params) => BigQuery.dryRun(sa, config, sql, params),
          ),
        ),
      );
    case "snowflake":
      return Effect.succeed(make(config.user, (sql, params) => Snowflake.query(config, credentials, sql, params)));
    case "clickhouse":
      return Effect.succeed(make(config.username, (sql, params) => ClickHouse.query(config, credentials, sql, params)));
    case "postgres":
      return Effect.succeed(make(config.user, (sql, params) => Postgres.query(config, credentials, sql, params)));
  }
};
