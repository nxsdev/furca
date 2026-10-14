import { Key } from "@furca/api/contract";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { FeatureValueType } from "@furca/core/features/Feature";
import { Schema } from "effect";
import { valueIssue } from "~/components/flags/ValueInput";
import { type ConditionValue, conditionIssue } from "~/components/targeting/ConditionBuilder";
import { i18n } from "~/i18n";

export interface VariationValues {
  readonly key: string;
  readonly name: string;
  readonly value: string;
  /** Used when evenSplit is off */
  readonly percent: number;
}

/** ExperimentForm values: the experiment draft plus the power planner inputs */
export interface ExperimentValues {
  name: string;
  key: string;
  hypothesis: string;
  featureId: string | null;
  variations: Array<VariationValues>;
  evenSplit: boolean;
  hashAttribute: string;
  conditions: ReadonlyArray<ConditionValue>;
  coverage: number;
  environmentIds: ReadonlyArray<string>;
  analysisEnvironmentId: string;
  primaryMetricId: string | null;
  secondaryMetricIds: ReadonlyArray<string>;
  guardrailMetricIds: ReadonlyArray<string>;
  stats: Experiment["stats"];
  mdePercent: number;
  dailyTraffic: number;
  baselineRate: number;
  baselineMean: number;
  baselineStdDev: number;
  /** Attribute names recorded with exposures for breakdowns (max 5) */
  dimensions: ReadonlyArray<string>;
  namespace: { readonly namespaceId: string; readonly start: number; readonly end: number } | null;
}

type Split = Pick<ExperimentValues, "evenSplit" | "variations">;

export const weightsOf = (v: Split) =>
  v.evenSplit ? v.variations.map(() => 1 / v.variations.length) : v.variations.map((x) => (Number.isFinite(x.percent) ? x.percent / 100 : 0));

/** Sum of the entered percentages (100 with an even split) */
export const totalPercent = (v: Split) =>
  v.evenSplit ? 100 : v.variations.reduce((a, x) => a + (Number.isFinite(x.percent) ? x.percent : 0), 0);

/** Blocking checklist items, in display order */
export type CheckId = "name" | "key" | "flag" | "values" | "keys" | "weights" | "targeting" | "envs" | "hash";

/** Something that blocks saving: the checklist item it fails and the form field that carries the message */
export interface Issue {
  readonly check: CheckId;
  readonly field: string;
  readonly message: string;
}

const isKey = Schema.is(Key);

/** Every problem that blocks saving. `valueType` is the selected flag's, undefined while none is selected */
export function draftIssues(v: ExperimentValues, ctx: { readonly isEdit: boolean; readonly valueType: FeatureValueType | undefined }): Array<Issue> {
  const issues: Array<Issue> = [];
  const add = (check: CheckId, field: string, message: string) => void issues.push({ check, field, message });
  if (v.name.trim() === "") add("name", "name", i18n.t("experiments:form.hypothesis.nameError"));
  if (!ctx.isEdit && !isKey(v.key)) add("key", "key", v.key === "" ? i18n.t("common:form.required") : i18n.t("experiments:form.hypothesis.keyError"));
  if (ctx.valueType === undefined) {
    add("flag", "featureId", i18n.t("experiments:form.flag.error"));
    // Values can only be checked against a flag's type
    add("values", "featureId", i18n.t("experiments:form.flag.error"));
  }
  v.variations.forEach((x, i) => {
    const valueError = ctx.valueType === undefined ? null : valueIssue(ctx.valueType, x.value);
    if (valueError !== null) add("values", `variations[${i}].value`, valueError);
    if (!isKey(x.key)) add("keys", `variations[${i}].key`, i18n.t("experiments:form.flag.keyFormat"));
    else if (v.variations.findIndex((y) => y.key === x.key) !== i) add("keys", `variations[${i}].key`, i18n.t("experiments:form.flag.keyUsed"));
  });
  if (Math.abs(totalPercent(v) - 100) >= 0.01 || weightsOf(v).some((w) => !(w > 0)))
    add("weights", "variations", i18n.t("experiments:form.checks.weights"));
  const condition = v.conditions.map((c) => conditionIssue(c)).find((m) => m !== null);
  if (condition != null) add("targeting", "conditions", condition);
  const ns = v.namespace;
  if (ns !== null && !(ns.start >= 0 && ns.start < ns.end && ns.end <= 1)) add("targeting", "namespace", i18n.t("namespaces:experimentForm.rangeInvalid"));
  if (v.environmentIds.length === 0) add("envs", "environmentIds", i18n.t("experiments:form.traffic.environmentsError"));
  if (v.hashAttribute.trim() === "") add("hash", "hashAttribute", i18n.t("common:form.required"));
  return issues;
}
