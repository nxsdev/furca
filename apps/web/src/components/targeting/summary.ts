import type { ConditionOperator } from "@furca/core/targeting/Condition";
import { i18n } from "~/i18n";

export interface ConditionValue {
  readonly attribute: string;
  readonly operator: ConditionOperator;
  readonly values: ReadonlyArray<string>;
}

/** Operator menu sections; labels live under `targeting:operatorGroups` / `targeting:operators` */
export const operatorGroups: ReadonlyArray<{ id: "text" | "number" | "version" | "presence"; operators: ReadonlyArray<ConditionOperator> }> = [
  { id: "text", operators: ["eq", "neq", "in", "not_in", "contains", "not_contains", "starts_with", "ends_with", "regex"] },
  { id: "number", operators: ["gt", "gte", "lt", "lte"] },
  { id: "version", operators: ["semver_gt", "semver_gte", "semver_lt", "semver_lte"] },
  { id: "presence", operators: ["exists", "not_exists"] },
];

export const isListOperator = (op: ConditionOperator) => op === "in" || op === "not_in";
export const isPresenceOperator = (op: ConditionOperator) => op === "exists" || op === "not_exists";

const listText = (values: ReadonlyArray<string>) =>
  values.length > 3 ? `${values.slice(0, 3).join(", ")} +${values.length - 3}` : values.join(", ");

/** "country is one of JP, US and plan is pro"; "Everyone" when there are no conditions */
export function conditionsSummary(conditions: ReadonlyArray<ConditionValue>): string {
  if (conditions.length === 0) return i18n.t("targeting:summary.everyone");
  return conditions
    .map(({ attribute, operator, values }) => {
      const value = isListOperator(operator) ? listText(values) : (values[0] ?? "");
      return i18n.t(`targeting:summary.${operator}`, { attribute: attribute === "" ? "…" : attribute, value: value === "" ? "…" : value });
    })
    .join(i18n.t("targeting:summary.and"));
}
