import { describe, expect, it } from "bun:test";
import { ExperimentRule, ForceRule, RolloutRule } from "../src/features/Feature";
import { type ExperimentReach, shadowedBy } from "../src/features/ruleReach";

const force = (conditions: number, enabled = true) =>
  new ForceRule({
    id: "f",
    description: "",
    enabled,
    conditions: Array.from({ length: conditions }, () => ({ attribute: "country", operator: "eq" as const, values: ["JP"] })),
    value: "true",
  });
const rollout = (coverage: number) =>
  new RolloutRule({ id: "r", description: "", enabled: true, conditions: [], value: "true", coverage, hashAttribute: "id", seed: "s" });
const experiment = (experimentId: string) => new ExperimentRule({ id: experimentId, enabled: true, experimentId });

const running: ExperimentReach = { status: "running", conditionCount: 0, coverage: 1, namespaced: false };
const experiments: Record<string, ExperimentReach> = {
  everyone: running,
  partial: { ...running, coverage: 0.5 },
  namespaced: { ...running, namespaced: true },
  draft: { ...running, status: "draft" },
};
const lookup = (id: string) => experiments[id];

describe("shadowedBy", () => {
  it("marks every live rule after an unconditional force rule as shadowed by it", () => {
    expect(shadowedBy([force(1), force(0), experiment("partial"), rollout(0.2)], lookup)).toEqual([null, null, 1, 1]);
  });

  it("does not treat partial rollouts, partial or namespaced experiments as catching everyone", () => {
    expect(shadowedBy([rollout(0.5), experiment("partial"), experiment("namespaced"), force(1)], lookup)).toEqual([null, null, null, null]);
  });

  it("reports an experiment starved by a running experiment that takes all traffic above it", () => {
    expect(shadowedBy([experiment("everyone"), experiment("partial")], lookup)).toEqual([null, 0]);
  });

  it("ignores rules that serve nobody anyway", () => {
    expect(shadowedBy([force(0), force(0, false), experiment("draft")], lookup)).toEqual([null, null, null]);
    expect(shadowedBy([force(0, false), rollout(1)], lookup)).toEqual([null, null]);
  });
});
