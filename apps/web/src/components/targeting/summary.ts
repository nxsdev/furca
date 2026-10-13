import type { ConditionOperator } from "@kuji/core/targeting/Condition";

export interface ConditionValue {
  readonly attribute: string;
  readonly operator: ConditionOperator;
  readonly values: ReadonlyArray<string>;
}

export const operatorGroups: ReadonlyArray<{ label: string; items: ReadonlyArray<readonly [ConditionOperator, string]> }> = [
  {
    label: "Text",
    items: [
      ["eq", "is"],
      ["neq", "is not"],
      ["in", "is one of"],
      ["not_in", "is not one of"],
      ["contains", "contains"],
      ["not_contains", "does not contain"],
      ["starts_with", "starts with"],
      ["ends_with", "ends with"],
      ["regex", "matches regex"],
    ],
  },
  {
    label: "Number",
    items: [
      ["gt", "greater than"],
      ["gte", "at least"],
      ["lt", "less than"],
      ["lte", "at most"],
    ],
  },
  {
    label: "Version",
    items: [
      ["semver_gt", "version >"],
      ["semver_gte", "version ≥"],
      ["semver_lt", "version <"],
      ["semver_lte", "version ≤"],
    ],
  },
  {
    label: "Presence",
    items: [
      ["exists", "exists"],
      ["not_exists", "does not exist"],
    ],
  },
];

export const operatorLabels = Object.fromEntries(operatorGroups.flatMap((g) => g.items)) as Record<ConditionOperator, string>;

export const isListOperator = (op: ConditionOperator) => op === "in" || op === "not_in";
export const isPresenceOperator = (op: ConditionOperator) => op === "exists" || op === "not_exists";

const listText = (values: ReadonlyArray<string>) =>
  values.length > 3 ? `${values.slice(0, 3).join(", ")} +${values.length - 3}` : values.join(", ");

/** "country is one of JP, US and plan is pro"; "Everyone" when there are no conditions */
export function conditionsSummary(conditions: ReadonlyArray<ConditionValue>): string {
  if (conditions.length === 0) return "Everyone";
  return conditions
    .map(({ attribute, operator, values }) => {
      const label = operatorLabels[operator] ?? operator;
      const name = attribute === "" ? "…" : attribute;
      if (isPresenceOperator(operator)) return `${name} ${label}`;
      const value = isListOperator(operator) ? listText(values) : (values[0] ?? "");
      return `${name} ${label} ${value === "" ? "…" : value}`;
    })
    .join(" and ");
}
