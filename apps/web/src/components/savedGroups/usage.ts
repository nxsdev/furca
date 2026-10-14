import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import type { ConditionValue } from "~/components/targeting/summary";

const groupIds = (conditions: ReadonlyArray<ConditionValue>) =>
  conditions.flatMap((c) => (c.operator === "in_group" || c.operator === "not_in_group" ? [c.values[0] ?? ""] : []));

export interface GroupUsage {
  readonly flags: Array<Feature>;
  readonly experiments: Array<Experiment>;
}

/** Flags (any rule, any environment) and draft / running experiments targeting each group, as the server's delete check sees them */
export const groupUsage = (features: ReadonlyArray<Feature>, experiments: ReadonlyArray<Experiment>): Map<string, GroupUsage> => {
  const out = new Map<string, GroupUsage>();
  const entry = (id: string) => {
    const existing = out.get(id);
    if (existing !== undefined) return existing;
    const created: GroupUsage = { flags: [], experiments: [] };
    out.set(id, created);
    return created;
  };
  for (const f of features) {
    const ids = f.environments.flatMap((e) => e.rules.flatMap((r) => (r._tag === "experiment" ? [] : groupIds(r.conditions))));
    for (const id of new Set(ids)) entry(id).flags.push(f);
  }
  for (const x of experiments) {
    if (x.status === "stopped") continue;
    for (const id of new Set(groupIds(x.conditions))) entry(id).experiments.push(x);
  }
  return out;
};

/** Pasted IDs: one per line (or comma / tab separated), trimmed, blanks and duplicates dropped */
export const parseIds = (text: string): { values: Array<string>; duplicates: number } => {
  const all = text
    .split(/[\n,\t]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const values = [...new Set(all)];
  return { values, duplicates: all.length - values.length };
};

export const MAX_LIST_VALUES = 10_000;
