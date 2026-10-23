import { Schema } from "effect";

/** The always-present built-in event store (D1). Seeded by migration */
export const BUILTIN_DATA_SOURCE_ID = "builtin";

export const WarehouseType = Schema.Literals(["bigquery", "snowflake", "clickhouse", "postgres"]);
export type WarehouseType = typeof WarehouseType.Type;

/** Product names, shown as is in every language */
export const WAREHOUSE_LABELS: Record<WarehouseType, string> = {
  bigquery: "BigQuery",
  snowflake: "Snowflake",
  clickhouse: "ClickHouse",
  postgres: "Postgres",
};

export const DataSourceType = Schema.Literals(["builtin", ...WarehouseType.literals]);
export type DataSourceType = typeof DataSourceType.Type;

/** Credentials: service account key JSON */
export class BigQueryConfig extends Schema.TaggedClass<BigQueryConfig>()("bigquery", {
  projectId: Schema.String,
  /** Default dataset for unqualified table names in SQL */
  dataset: Schema.String,
  /** Job location, e.g. US, EU, asia-northeast1 */
  location: Schema.String,
}) {}

/** Credentials: unencrypted PKCS#8 private key PEM (key-pair auth) */
export class SnowflakeConfig extends Schema.TaggedClass<SnowflakeConfig>()("snowflake", {
  /** Account identifier, the host part before .snowflakecomputing.com (e.g. myorg-myaccount) */
  account: Schema.String,
  user: Schema.String,
  warehouse: Schema.String,
  database: Schema.String,
  schema: Schema.String,
  /** Empty uses the user's default role */
  role: Schema.String,
}) {}

/** Credentials: the user's password. Talks to the HTTPS interface */
export class ClickHouseConfig extends Schema.TaggedClass<ClickHouseConfig>()("clickhouse", {
  /** https://host:8443 */
  url: Schema.String,
  database: Schema.String,
  username: Schema.String,
}) {}

/** Credentials: the user's password. Any Postgres wire-compatible database */
export class PostgresConfig extends Schema.TaggedClass<PostgresConfig>()("postgres", {
  host: Schema.String,
  port: Schema.Int,
  database: Schema.String,
  user: Schema.String,
  ssl: Schema.Literals(["require", "disable"]),
}) {}

/** Connection settings of a warehouse source; `_tag` equals the source's type */
export const WarehouseConfig = Schema.Union([BigQueryConfig, SnowflakeConfig, ClickHouseConfig, PostgresConfig]);
export type WarehouseConfig = typeof WarehouseConfig.Type;

export class DataSource extends Schema.Class<DataSource>("DataSource")({
  id: Schema.String,
  name: Schema.String,
  type: DataSourceType,
  /** null for the builtin source */
  config: Schema.NullOr(WarehouseConfig),
  /** Credentials are stored encrypted and never returned */
  hasCredentials: Schema.Boolean,
  /**
   * Warehouse only. SQL returning one row per exposure with columns
   * user_id, timestamp, experiment_id, variation_id (same as a GrowthBook exposure query)
   */
  exposureSql: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}
