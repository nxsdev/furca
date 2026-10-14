import { type DataSource, WAREHOUSE_LABELS, type WarehouseConfig, type WarehouseType } from "@furca/core/datasources/DataSource";
import { i18n } from "~/i18n";

/** Seeded name of the built-in source (packages/database seed migration) */
const BUILTIN_SEED_NAME = "Built-in event store";

/** Shows the seeded built-in source name in the UI language; a name someone changed is shown as is */
export const dataSourceName = (s: Pick<DataSource, "type" | "name">): string =>
  s.type === "builtin" && s.name === BUILTIN_SEED_NAME ? i18n.t("datasources:builtinName") : s.name;

/** "BigQuery", "Snowflake", ... or the built-in store's label */
export const dataSourceTypeLabel = (s: Pick<DataSource, "type">): string =>
  s.type === "builtin" ? i18n.t("datasources:list.builtinType") : WAREHOUSE_LABELS[s.type];

/** Where a warehouse source points, in one line */
export const configSummary = (c: WarehouseConfig): string => {
  switch (c._tag) {
    case "bigquery":
      return `${c.projectId}.${c.dataset} · ${c.location}`;
    case "snowflake":
      return `${c.account} · ${c.database}.${c.schema}`;
    case "clickhouse":
      return `${URL.parse(c.url)?.host ?? c.url} · ${c.database}`;
    case "postgres":
      return `${c.host}:${c.port} · ${c.database}`;
  }
};

/** Column types each dialect expects from exposure and metric SQL, for help text and templates */
export const SQL_TYPES: Record<WarehouseType, { readonly text: string; readonly time: string; readonly float: string }> = {
  bigquery: { text: "STRING", time: "TIMESTAMP", float: "FLOAT64" },
  snowflake: { text: "VARCHAR", time: "TIMESTAMP", float: "FLOAT" },
  clickhouse: { text: "String", time: "DateTime", float: "Float64" },
  postgres: { text: "text", time: "timestamptz", float: "double precision" },
};
