import { describe, expect, it } from "bun:test";
import { defaultStatsSettings } from "@furca/core/experiments/Experiment";
import { draftIssues, type ExperimentValues } from "./draft";

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
