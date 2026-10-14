import { describe, expect, it } from "bun:test";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { servesOnlyFalse, servingText } from "./serving";

const flag = (enabled: boolean, rules: ReadonlyArray<Record<string, unknown>>): Feature =>
  ({
    valueType: "boolean",
    defaultValue: "false",
    environments: [{ environmentId: "prod", enabled, rules }],
  }) as unknown as Feature;
const force = (value: string, enabled = true) => ({ _tag: "force", id: value, enabled, conditions: [], value, description: "" });

describe("servingText", () => {
  it("says what SDKs get instead of just on / off", () => {
    expect(servingText(flag(false, [force("true")]), "prod")).toBe("SDKs return the fallback value in your code");
    expect(servingText(flag(true, []), "prod")).toBe("Everyone gets false");
    expect(servingText(flag(true, [force("true", false)]), "prod")).toBe("Everyone gets false");
    const vip = { ...force("true"), conditions: [{ attribute: "plan", operator: "eq", values: ["vip"] }] };
    expect(servingText(flag(true, [vip]), "prod")).toBe("Users matching a rule get true, everyone else false");
    // A rule without conditions serves everyone: the default is never reached
    expect(servingText(flag(true, [force("true")]), "prod")).toBe("Everyone gets true");
  });

  it("ignores experiment rules whose experiment is not running", () => {
    const rule = { _tag: "experiment", id: "x", enabled: true, experimentId: "e1" };
    const draft = new Map([["e1", { status: "draft" } as Experiment]]);
    expect(servingText(flag(true, [rule]), "prod", draft)).toBe("Everyone gets false");
    expect(servingText(flag(true, [rule]), "prod")).toBe("Users matching a rule get that rule's value, everyone else false");
  });
});

describe("servesOnlyFalse", () => {
  it("flags a boolean that is on with no enabled rules and a false default", () => {
    expect(servesOnlyFalse(flag(true, []), "prod")).toBe(true);
    expect(servesOnlyFalse(flag(true, [force("true")]), "prod")).toBe(false);
    expect(servesOnlyFalse(flag(false, []), "prod")).toBe(false);
  });
});
