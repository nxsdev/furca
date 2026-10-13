import { describe, expect, it } from "bun:test";
import { diffLines, foldUnchanged, prettyLines } from "./diff";

describe("audit diff", () => {
  it("marks only the changed value when one field of a snapshot changes, ignoring key order", () => {
    const before = prettyLines(JSON.stringify({ name: "Checkout", windowHours: 72, inverse: false }));
    const after = prettyLines(JSON.stringify({ inverse: false, windowHours: 24, name: "Checkout" }));
    const changed = diffLines(before, after).filter((l) => l.kind !== "same");
    expect(changed).toEqual([
      { kind: "del", text: '  "windowHours": 72' },
      { kind: "add", text: '  "windowHours": 24' },
    ]);
  });

  it("folds long unchanged runs but keeps context lines around a change", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i === 10 ? "changed" : l));
    const rows = foldUnchanged(diffLines(a, b), 3);
    expect(rows[0]).toEqual({ kind: "skip", count: 7 });
    expect(rows.filter((r) => r.kind === "same")).toHaveLength(6);
    expect(rows.at(-1)).toEqual({ kind: "skip", count: 6 });
  });
});
