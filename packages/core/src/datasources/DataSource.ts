import { Schema } from "effect";

/** The always-present built-in event store (D1). Seeded by migration */
export const BUILTIN_DATA_SOURCE_ID = "builtin";

export const DataSourceType = Schema.Literals(["builtin", "bigquery"]);
export type DataSourceType = typeof DataSourceType.Type;

export class BigQueryConfig extends Schema.Class<BigQueryConfig>("BigQueryConfig")({
  projectId: Schema.String,
  /** Default dataset for unqualified table names in SQL */
  dataset: Schema.String,
  /** Job location, e.g. US, EU, asia-northeast1 */
  location: Schema.String,
}) {}

export class DataSource extends Schema.Class<DataSource>("DataSource")({
  id: Schema.String,
  name: Schema.String,
  type: DataSourceType,
  bigquery: Schema.NullOr(BigQueryConfig),
  /** Credentials are stored encrypted and never returned */
  hasCredentials: Schema.Boolean,
  /**
   * Warehouse only. SQL returning one row per exposure with columns
   * user_id, timestamp, experiment_key, variation_key
   */
  exposureSql: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}
