import { describe, expect, it } from "bun:test";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { groupUsage, parseIds } from "./usage";

const inGroup = (id: string) => ({ attribute: "", operator: "in_group" as const, values: [id] });

describe("saved group helpers", () => {
  it("parses pasted IDs, dropping blanks and counting duplicates", () => {
    expect(parseIds(" u1\nu2,u1\r\n\n\tu3 ")).toEqual({ values: ["u1", "u2", "u3"], duplicates: 1 });
  });

  it("counts each flag once and ignores stopped experiments", () => {
    const flag = {
      id: "f",
      environments: [
        { environmentId: "a", enabled: true, rules: [{ _tag: "force", conditions: [inGroup("g")] }] },
        { environmentId: "b", enabled: true, rules: [{ _tag: "rollout", conditions: [inGroup("g")] }] },
      ],
    } as unknown as Feature;
    const running = { id: "x", status: "running", conditions: [inGroup("g")] } as unknown as Experiment;
    const stopped = { id: "y", status: "stopped", conditions: [inGroup("g")] } as unknown as Experiment;
    const usage = groupUsage([flag], [running, stopped]).get("g");
    expect(usage?.flags.map((f) => f.id)).toEqual(["f"]);
    expect(usage?.experiments.map((x) => x.id)).toEqual(["x"]);
  });
});
