/** Saved-group references inside targeting conditions (in_group / not_in_group, values[0] = group id) */
import type { Condition, ConditionOperator } from "@furca/core/targeting/Condition";
import type { DatabaseShape } from "@furca/database/Database";
import { Effect } from "effect";
import { invalid } from "./shared";

export const isGroupOperator = (operator: ConditionOperator) => operator === "in_group" || operator === "not_in_group";

/** Group ids referenced by the conditions ("" when a group condition has none chosen) */
export const groupIdsOf = (conditions: ReadonlyArray<Condition>): Array<string> =>
  conditions.flatMap((c) => (isGroupOperator(c.operator) ? [c.values[0] ?? ""] : []));

/**
 * ValidationError when a condition set references a saved group that does not exist. `rule`: the
 * flag rule's 1-based number, or null for an experiment's targeting
 */
export const requireGroups = Effect.fn("requireGroups")(function* (
  database: DatabaseShape,
  sets: ReadonlyArray<{ readonly rule: number | null; readonly conditions: ReadonlyArray<Condition> }>,
) {
  const ids = [...new Set(sets.flatMap((s) => groupIdsOf(s.conditions)))].filter((id) => id !== "");
  const rows =
    ids.length === 0
      ? []
      : yield* database.run("savedGroups.byIds", (db) => db.query.savedGroups.findMany({ where: { id: { in: ids } }, columns: { id: true } }));
  const known = new Set(rows.map((r) => r.id));
  for (const { rule, conditions } of sets) {
    for (const id of groupIdsOf(conditions)) {
      if (id === "") return yield* (rule === null ? invalid("experiment.targetingGroupRequired", undefined, "conditions") : invalid("rule.groupRequired", { rule }));
      if (!known.has(id)) return yield* (rule === null ? invalid("experiment.targetingGroupGone", undefined, "conditions") : invalid("rule.groupGone", { rule }));
    }
  }
});
