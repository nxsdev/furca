import { describe, expect, it } from "bun:test";
import type { Rule } from "~/components/flags/RulesEditor";
import { ruleDiff } from "./ruleDiff";

const force = (id: string, value = "true"): Rule => ({ _tag: "force", id, description: "", enabled: true, conditions: [], value });

describe("ruleDiff", () => {
  it("marks new, changed and removed rules, and leaves rules alone when only a rule above was added", () => {
    const kinds = ruleDiff([force("a"), force("b"), force("c")], [force("new"), force("a"), force("b", "false")]);
    expect(kinds.map((l) => [l.rule.id, l.kind])).toEqual([
      ["new", "added"],
      ["a", "same"],
      ["b", "changed"],
      ["c", "removed"],
    ]);
    expect(kinds[2]?.previous).toEqual(force("b"));
  });

  it("marks reordered rules as moved", () => {
    expect(ruleDiff([force("a"), force("b")], [force("b"), force("a")]).map((l) => l.kind)).toEqual(["moved", "moved"]);
  });
});
