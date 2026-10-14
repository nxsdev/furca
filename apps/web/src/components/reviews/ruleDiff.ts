import type { Rule } from "~/components/flags/RulesEditor";

export type DiffKind = "added" | "changed" | "removed" | "moved" | "same";

/** Rules after the change, each marked against the rules before it; removed rules come last */
export const ruleDiff = (
  before: ReadonlyArray<Rule>,
  after: ReadonlyArray<Rule>,
): Array<{ rule: Rule; previous: Rule | null; kind: DiffKind }> => {
  const old = new Map(before.map((r) => [r.id, r]));
  const kept = new Set(after.map((r) => r.id));
  const orderBefore = before.filter((r) => kept.has(r.id)).map((r) => r.id);
  const orderAfter = after.filter((r) => old.has(r.id)).map((r) => r.id);
  return [
    ...after.map((rule) => {
      const previous = old.get(rule.id) ?? null;
      const kind: DiffKind =
        previous === null
          ? "added"
          : JSON.stringify(previous) !== JSON.stringify(rule)
            ? "changed"
            : orderBefore.indexOf(rule.id) !== orderAfter.indexOf(rule.id)
              ? "moved"
              : "same";
      return { rule, previous, kind };
    }),
    ...before.filter((r) => !kept.has(r.id)).map((rule) => ({ rule, previous: null, kind: "removed" as const })),
  ];
};
