import type { DataSource } from "@furca/core/datasources/DataSource";
import { i18n } from "~/i18n";

/** Seeded name of the built-in source (packages/database seed migration) */
const BUILTIN_SEED_NAME = "Built-in event store";

/** Shows the seeded built-in source name in the UI language; a name someone changed is shown as is */
export const dataSourceName = (s: Pick<DataSource, "type" | "name">): string =>
  s.type === "builtin" && s.name === BUILTIN_SEED_NAME ? i18n.t("datasources:builtinName") : s.name;
