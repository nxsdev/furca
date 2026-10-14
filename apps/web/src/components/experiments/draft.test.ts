import { describe, expect, it } from "bun:test";
import { defaultStatsSettings } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import { defaultEnvironments, draftIssues, type ExperimentValues, newDraft, startChecks, variationsFor } from "./draft";

const valid: ExperimentValues = {
  name: "One-page checkout",
  key: "one-page-checkout",
  hypothesis: "",
  featureId: "f1",
  variations: [
    { key: "control", name: "Control", value: "false", percent: 50 },
    { key: "treatment", name: "Treatment", value: "true", percent: 50 },
  ],
  evenSplit: true,
  hashAttribute: "id",
  conditions: [],
  coverage: 1,
  environmentIds: ["prod"],
  analysisEnvironmentId: "prod",
  primaryMetricId: null,
  secondaryMetricIds: [],
  guardrailMetricIds: [],
  stats: defaultStatsSettings(),
  mdePercent: 5,
  dailyTraffic: Number.NaN,
  baselineRate: Number.NaN,
  baselineMean: Number.NaN,
  baselineStdDev: Number.NaN,
  dimensions: [],
  namespace: null,
};

const issues = (patch: Partial<ExperimentValues>, { isEdit = false, noFlag = false } = {}) =>
  draftIssues({ ...valid, ...patch }, { isEdit, valueType: noFlag ? undefined : "boolean" }).map((i) => `${i.check} ${i.field}`);

describe("experiment draft issues", () => {
  it("passes a complete draft", () => {
    expect(issues({})).toEqual([]);
  });

  it("checks the key on create only", () => {
    expect(issues({ key: "Bad Key" })).toEqual(["key key"]);
    expect(issues({ key: "" })).toEqual(["key key"]);
    expect(issues({ key: "" }, { isEdit: true })).toEqual([]);
  });

  it("needs a flag before values can pass", () => {
    expect(issues({}, { noFlag: true })).toEqual(["flag featureId", "values featureId"]);
    expect(issues({ variations: [valid.variations[0]!, { ...valid.variations[1]!, value: '"yes"' }] })).toEqual(["values variations[1].value"]);
  });

  it("puts duplicate variation keys on the later variation", () => {
    const [control, treatment] = valid.variations as [ExperimentValues["variations"][0], ExperimentValues["variations"][0]];
    expect(issues({ variations: [control, { ...treatment, key: "control" }, { ...treatment, key: "B!" }] })).toEqual([
      "keys variations[1].key",
      "keys variations[2].key",
    ]);
  });

  it("ignores custom percentages under an even split, and requires 100% without zeros otherwise", () => {
    const [control, treatment] = valid.variations as [ExperimentValues["variations"][0], ExperimentValues["variations"][0]];
    expect(issues({ variations: [{ ...control, percent: 10 }, treatment] })).toEqual([]);
    expect(issues({ evenSplit: false, variations: [{ ...control, percent: 60 }, treatment] })).toEqual(["weights variations"]);
    expect(issues({ evenSplit: false, variations: [{ ...control, percent: 100 }, { ...treatment, percent: 0 }] })).toEqual(["weights variations"]);
    expect(issues({ evenSplit: false, variations: [{ ...control, percent: 33.34 }, { ...treatment, percent: 66.66 }] })).toEqual([]);
  });

  it("reports incomplete targeting, no environment and a blank hash attribute", () => {
    expect(issues({ conditions: [{ attribute: "", operator: "eq", values: [] }], environmentIds: [], hashAttribute: " " })).toEqual([
      "targeting conditions",
      "envs environmentIds",
      "hash hashAttribute",
    ]);
  });
});

const flag = (valueType: "boolean" | "string", defaultValue: string, on: ReadonlyArray<string>) =>
  ({
    id: "f1",
    valueType,
    defaultValue,
    environments: ["dev", "staging", "prod"].map((environmentId) => ({ environmentId, enabled: on.includes(environmentId) })),
  }) as unknown as Feature;
const envs = [
  { id: "dev", key: "development" },
  { id: "staging", key: "staging" },
  { id: "prod", key: "production" },
];

describe("new experiment defaults", () => {
  it("tests false against true on a boolean flag, whatever its default", () => {
    expect(variationsFor(flag("boolean", "true", [])).map((v) => [v.key, v.value])).toEqual([
      ["control", "false"],
      ["treatment", "true"],
    ]);
  });

  it("starts both arms on the default of other flag types, leaving the treatment to fill in", () => {
    expect(variationsFor(flag("string", '"blue"', [])).map((v) => v.value)).toEqual(['"blue"', '"blue"']);
  });

  it("runs where the flag is on and analyzes the production-like environment, or everywhere when it is on nowhere", () => {
    expect(defaultEnvironments(flag("boolean", "false", ["staging", "prod"]), envs)).toEqual({ environmentIds: ["staging", "prod"], analysisEnvironmentId: "prod" });
    expect(defaultEnvironments(flag("boolean", "false", []), envs)).toEqual({ environmentIds: ["dev", "staging", "prod"], analysisEnvironmentId: "prod" });
    expect(defaultEnvironments(flag("boolean", "false", ["dev", "staging"]), envs).analysisEnvironmentId).toBe("dev");
  });

  it("makes a draft that saves as is: even split, everyone, hash on id, default statistics", () => {
    const d = newDraft({ name: "購入ボタン", key: "exp-abc123", feature: flag("boolean", "false", ["prod"]), primaryMetricId: "m1", environments: envs });
    expect(draftIssues(d, { isEdit: false, valueType: "boolean" })).toEqual([]);
    expect(d).toMatchObject({ evenSplit: true, conditions: [], coverage: 1, hashAttribute: "id", environmentIds: ["prod"], primaryMetricId: "m1" });
    expect(d.stats).toEqual(defaultStatsSettings());
  });
});

describe("start checklist", () => {
  const checks = (patch: Partial<ExperimentValues>, ctx: Partial<Parameters<typeof startChecks>[1]> = {}) => {
    const r = startChecks({ ...valid, ...patch }, { valueType: "boolean", flagOffIn: [], planDays: null, planned: false, ...ctx });
    return { blockers: r.blockers.map((c) => `${c.id} ${c.section}`), advice: r.advice.map((c) => c.id) };
  };

  it("blocks starting only on a missing primary metric or a draft problem", () => {
    expect(checks({}).blockers).toEqual(["primary metrics"]);
    expect(checks({ primaryMetricId: "m1", environmentIds: [] }).blockers).toEqual(["envs targeting"]);
    expect(checks({ primaryMetricId: "m1" }).blockers).toEqual([]);
  });

  it("recommends a guardrail, a hypothesis and a plan without blocking", () => {
    const c = checks({ primaryMetricId: "m1" });
    expect(c.blockers).toEqual([]);
    expect(c.advice).toEqual(["guardrail", "hypothesis", "plan"]);
    expect(checks({ primaryMetricId: "m1", guardrailMetricIds: ["g"], hypothesis: "x" }, { planned: true, planDays: 20 }).advice).toEqual([]);
  });

  it("warns about an A/A treatment, a flag that is off, and a plan over 6 weeks", () => {
    const [control] = valid.variations as [ExperimentValues["variations"][0]];
    const c = checks(
      { primaryMetricId: "m1", guardrailMetricIds: ["g"], hypothesis: "x", variations: [control, { ...control, key: "treatment" }] },
      { flagOffIn: ["Staging"], planned: true, planDays: 43 },
    );
    expect(c.advice).toEqual(["sameValue", "flagOff", "longPlan"]);
    expect(checks({ primaryMetricId: "m1", guardrailMetricIds: ["g"], hypothesis: "x" }, { planned: true, planDays: 42 }).advice).toEqual([]);
  });
});
