import { describe, expect, it } from "bun:test";
import { hash, type SdkPayload } from "@furca/sdk";
import { alignRules, traceEvaluation } from "./simulate";

// Pick a seed so that user "u1" lands inside a 50% rollout and "u2" outside it
const seed = "s1";
const [inside, outside] = ["u1", "u2", "u3", "u4", "u5"].reduce<[string, string]>(
  ([i, o], id) => [i || (hash(seed, id) < 0.5 ? id : ""), o || (hash(seed, id) >= 0.5 ? id : "")],
  ["", ""],
);

const payload: SdkPayload = {
  version: 1,
  environment: "production",
  generatedAt: "2026-10-13T00:00:00.000Z",
  features: {
    checkout: {
      defaultValue: false,
      rules: [
        { type: "force", conditions: [{ attribute: "country", operator: "in", values: ["JP", "US"] }], value: true },
        { type: "rollout", conditions: [], value: true, coverage: 0.5, hashAttribute: "id", seed },
      ],
    },
  },
};

describe("traceEvaluation", () => {
  it("explains a failed condition and stops at the matching rollout", () => {
    const { evaluation, steps } = traceEvaluation(payload, "checkout", { id: inside, country: "GB" });
    expect(evaluation.ruleIndex).toBe(1);
    expect(steps.map((s) => s.matched)).toEqual([false, true]);
    expect(steps[0]!.reason).toBe('Needs country is one of JP, US (has "GB")');
  });

  it("falls through to the default when the user is outside the rollout", () => {
    const { evaluation, steps } = traceEvaluation(payload, "checkout", { id: outside });
    expect(evaluation.source).toBe("default");
    expect(steps[0]!.reason).toBe("Needs country is one of JP, US (not set)");
    expect(steps[1]!.reason).toStartWith("Outside the 50% rollout");
  });

  it("reports a missing hash attribute instead of bucketing an empty id", () => {
    const { steps } = traceEvaluation(payload, "checkout", {});
    expect(steps[1]!.reason).toBe("No id attribute to bucket by");
  });

  it("agrees with evaluate on saved groups and namespaces", () => {
    const withTargeting: SdkPayload = {
      ...payload,
      savedGroups: { g1: { type: "list", attribute: "id", values: ["vip"] } },
      features: {
        checkout: {
          defaultValue: false,
          rules: [
            { type: "force", conditions: [{ attribute: "", operator: "in_group", values: ["g1"] }], value: true },
            {
              type: "experiment",
              key: "exp",
              conditions: [],
              coverage: 1,
              hashAttribute: "id",
              seed: "exp",
              phase: 0,
              namespace: ["ns", 0, 0],
              variations: [
                { key: "control", value: false },
                { key: "treatment", value: true },
              ],
              weights: [0.5, 0.5],
            },
          ],
        },
      },
    };
    const vip = traceEvaluation(withTargeting, "checkout", { id: "vip" });
    expect(vip.evaluation.ruleIndex).toBe(0);
    expect(vip.steps.map((s) => s.matched)).toEqual([true]);
    const other = traceEvaluation(withTargeting, "checkout", { id: "someone" });
    expect(other.evaluation.source).toBe("default");
    expect(other.steps[0]!.reason).toStartWith("Needs ");
    expect(other.steps[0]!.reason).not.toContain("not set");
    expect(other.steps[1]!.reason).toBe("Outside this experiment's slice of namespace ns");
  });
});

describe("alignRules", () => {
  it("skips saved rules that are not in the payload (disabled) and keeps order", () => {
    const ids = alignRules(
      payload.features.checkout!.rules,
      [
        { _tag: "rollout", id: "disabled", enabled: false, seed: "other" },
        { _tag: "force", id: "a", enabled: true, conditions: [{ attribute: "country", operator: "in", values: ["JP", "US"] }], value: "true" },
        { _tag: "rollout", id: "b", enabled: true, seed },
      ],
      new Map(),
    );
    expect(ids).toEqual(["a", "b"]);
  });
});
