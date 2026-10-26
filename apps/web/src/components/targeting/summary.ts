import type { ConditionOperator } from "@furca/core/targeting/Condition";
import { useQuery } from "@tanstack/react-query";
import { i18n } from "~/i18n";
import { orpc } from "~/lib/rpc";

export interface ConditionValue {
  readonly attribute: string;
  readonly operator: ConditionOperator;
  readonly values: ReadonlyArray<string>;
}

/** Operator menu sections; labels live under `targeting:operatorGroups` / `targeting:operators` */
export const operatorGroups: ReadonlyArray<{
  id: "text" | "number" | "version" | "presence" | "savedGroups";
  operators: ReadonlyArray<ConditionOperator>;
}> = [
  { id: "text", operators: ["eq", "neq", "in", "not_in", "contains", "not_contains", "starts_with", "ends_with", "regex"] },
  { id: "number", operators: ["gt", "gte", "lt", "lte"] },
  { id: "version", operators: ["semver_gt", "semver_gte", "semver_lt", "semver_lte"] },
  { id: "presence", operators: ["exists", "not_exists"] },
  { id: "savedGroups", operators: ["in_group", "not_in_group"] },
];

export const isListOperator = (op: ConditionOperator) => op === "in" || op === "not_in";
export const isPresenceOperator = (op: ConditionOperator) => op === "exists" || op === "not_exists";
/** values[0] is a saved group id; the attribute is ignored */
export const isGroupOperator = (op: ConditionOperator) => op === "in_group" || op === "not_in_group";

/** Group names seen by any mounted useConditionsSummary, so plain callers (e.g. simulate) can name groups too */
const knownGroupNames = new Map<string, string>();
const knownGroupName = (id: string) => knownGroupNames.get(id) ?? i18n.t(($) => $.summary.unknownGroup, { ns: "targeting" });

const listText = (values: ReadonlyArray<string>) =>
  values.length > 3 ? `${values.slice(0, 3).join(", ")} +${values.length - 3}` : values.join(", ");

/**
 * "country is one of JP, US and plan is pro"; "Everyone" when there are no conditions.
 * Saved groups are shown by name (`groupName`, else names loaded by useConditionsSummary)
 */
export function conditionsSummary(conditions: ReadonlyArray<ConditionValue>, groupName: (id: string) => string = knownGroupName): string {
  if (conditions.length === 0) return i18n.t(($) => $.summary.everyone, { ns: "targeting" });
  return conditions
    .map(({ attribute, operator, values }) => {
      const value = isGroupOperator(operator)
        ? values[0] === undefined || values[0] === "" ? "" : groupName(values[0])
        : isListOperator(operator) ? listText(values) : (values[0] ?? "");
      return i18n.t(($) => $.summary[operator], { ns: "targeting", attribute: attribute === "" ? "…" : attribute, value: value === "" ? "…" : value });
    })
    .join(i18n.t(($) => $.summary.and, { ns: "targeting" }));
}

/** conditionsSummary that re-renders with saved group names once they load */
export function useConditionsSummary(): (conditions: ReadonlyArray<ConditionValue>) => string {
  const groups = useQuery(orpc.savedGroups.list.queryOptions());
  for (const g of groups.data ?? []) knownGroupNames.set(g.id, g.name);
  const name = (id: string) => knownGroupNames.get(id) ?? (groups.isPending ? "…" : i18n.t(($) => $.summary.unknownGroup, { ns: "targeting" }));
  return (conditions) => conditionsSummary(conditions, name);
}
