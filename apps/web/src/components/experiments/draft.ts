import { Key } from "@furca/api/contract";
import { BUILTIN_DATA_SOURCE_ID } from "@furca/core/datasources/DataSource";
import type { Environment } from "@furca/core/environments/Environment";
import { defaultStatsSettings, type Experiment } from "@furca/core/experiments/Experiment";
import type { Feature, FeatureValueType } from "@furca/core/features/Feature";
import type { Metric } from "@furca/core/metrics/Metric";
import { daysToReach, mdeForSampleSize, sampleSizePerVariation } from "@furca/stats";
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

/** Draft editor values: the experiment draft plus the power planner inputs */
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

/**
 * Starting variations for a flag: boolean flags test false (control) against true; other types start
 * both on the flag's default value and the treatment is left for the user to fill in
 */
export const variationsFor = (feature: Pick<Feature, "valueType" | "defaultValue"> | undefined): Array<VariationValues> => {
  const [control, treatment] =
    feature === undefined ? ["", ""] : feature.valueType === "boolean" ? ["false", "true"] : [feature.defaultValue, feature.defaultValue];
  return [
    { key: "control", name: i18n.t("experiments:form.defaults.control"), value: control, percent: 50 },
    { key: "treatment", name: i18n.t("experiments:form.defaults.treatment"), value: treatment, percent: 50 },
  ];
};

/**
 * Where a new experiment runs: every environment the flag is on in (all of them when it is on
 * nowhere), analyzed in the first production-like one
 */
export const defaultEnvironments = (
  feature: Pick<Feature, "environments"> | undefined,
  environments: ReadonlyArray<Pick<Environment, "id" | "key">>,
): { environmentIds: Array<string>; analysisEnvironmentId: string } => {
  const on = environments.filter((e) => feature?.environments.some((c) => c.environmentId === e.id && c.enabled) === true);
  const chosen = on.length > 0 ? on : environments;
  const analysis = chosen.find((e) => /prod/i.test(e.key)) ?? chosen[0];
  return { environmentIds: chosen.map((e) => e.id), analysisEnvironmentId: analysis?.id ?? "" };
};

/** A new draft from the three things creation asks for; everything else is a default */
export const newDraft = (input: {
  readonly name: string;
  readonly key: string;
  readonly feature: Feature | undefined;
  readonly primaryMetricId: string | null;
  readonly environments: ReadonlyArray<Pick<Environment, "id" | "key">>;
}): ExperimentValues => ({
  name: input.name,
  key: input.key,
  hypothesis: "",
  featureId: input.feature?.id ?? null,
  variations: variationsFor(input.feature),
  evenSplit: true,
  hashAttribute: "id",
  conditions: [],
  coverage: 1,
  ...defaultEnvironments(input.feature, input.environments),
  primaryMetricId: input.primaryMetricId,
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
});

export const toValues = (x: Experiment): ExperimentValues => {
  const n = x.variations.length;
  return {
    name: x.name,
    key: x.key,
    hypothesis: x.hypothesis,
    featureId: x.featureId,
    variations: x.variations.map((v, i) => ({ key: v.key, name: v.name, value: v.value, percent: Number(((x.weights[i] ?? 0) * 100).toFixed(2)) })),
    evenSplit: x.weights.every((w) => Math.abs(w - 1 / n) < 1e-3),
    hashAttribute: x.hashAttribute,
    conditions: x.conditions,
    coverage: x.coverage,
    environmentIds: x.environmentIds,
    analysisEnvironmentId: x.analysisEnvironmentId,
    primaryMetricId: x.primaryMetricId,
    secondaryMetricIds: x.secondaryMetricIds,
    guardrailMetricIds: x.guardrailMetricIds,
    stats: x.stats,
    mdePercent: Number((x.plan.mde * 100).toFixed(2)) || 5,
    dailyTraffic: x.plan.dailyTraffic ?? Number.NaN,
    baselineRate: Number.NaN,
    baselineMean: Number.NaN,
    baselineStdDev: Number.NaN,
    dimensions: x.dimensions,
    namespace: x.namespace,
  };
};

/** Plans longer than this get a warning and shorter alternatives */
export const LONG_PLAN_DAYS = 42;

/** Power analysis for the planner; null fields when inputs are incomplete */
export function planOf(d: ExperimentValues, primary: Pick<Metric, "type"> | undefined) {
  const kind = primary === undefined || primary.type === "proportion" ? "proportion" : "mean";
  const baselineMean = kind === "proportion" ? d.baselineRate / 100 : d.baselineMean;
  const power = { kind, baselineMean, baselineStdDev: d.baselineStdDev, alpha: d.stats.alpha } as const;
  const perVariation = sampleSizePerVariation({ ...power, mde: d.mdePercent / 100 });
  const weights = weightsOf(d);
  const minWeight = Math.min(...weights);
  // daysToReach assumes an equal split; 1 / smallest weight gives the arm that fills slowest
  const traffic = { variations: 1 / minWeight, dailyTraffic: d.dailyTraffic, coverage: d.coverage };
  const days = perVariation === null || !(d.dailyTraffic > 0) ? null : daysToReach({ usersPerVariation: perVariation, ...traffic });
  const mdeIn = (n: number) => {
    const users = d.dailyTraffic * d.coverage * minWeight * n;
    return users > 0 ? mdeForSampleSize({ ...power, usersPerVariation: users }) : null;
  };
  return { kind, perVariation, total: perVariation === null ? null : perVariation * weights.length, days, mdeIn14: mdeIn(14), mdeIn28: mdeIn(28) };
}

/** Days the saved plan needs at the saved traffic, null when not planned */
export const savedPlanDays = (x: Pick<Experiment, "plan" | "weights" | "coverage">): number | null => {
  const { sampleSizePerVariation: n, dailyTraffic } = x.plan;
  if (n === null || dailyTraffic === null) return null;
  return daysToReach({ usersPerVariation: n, variations: 1 / Math.min(...x.weights), dailyTraffic, coverage: x.coverage });
};

/** The saved experiment as experiments.update input fields (without id) */
export const savedFields = (x: Experiment) => ({
  name: x.name,
  hypothesis: x.hypothesis,
  featureId: x.featureId,
  environmentIds: [...x.environmentIds],
  analysisEnvironmentId: x.analysisEnvironmentId,
  hashAttribute: x.hashAttribute,
  variations: x.variations.map((v) => ({ key: v.key, name: v.name, value: v.value })),
  coverage: x.coverage,
  weights: [...x.weights],
  conditions: x.conditions.map((c) => ({ ...c, values: [...c.values] })),
  dataSourceId: x.dataSourceId,
  primaryMetricId: x.primaryMetricId,
  secondaryMetricIds: [...x.secondaryMetricIds],
  guardrailMetricIds: [...x.guardrailMetricIds],
  stats: { ...x.stats },
  plan: { ...x.plan },
  dimensions: [...x.dimensions],
  namespace: x.namespace === null ? null : { ...x.namespace },
});

/** experiments.create / update input (without key / id) */
export const toInput = (v: ExperimentValues, primary: Metric | undefined) => {
  const plan = planOf(v, primary);
  return {
    name: v.name.trim(),
    hypothesis: v.hypothesis.trim(),
    featureId: v.featureId ?? "",
    environmentIds: [...v.environmentIds],
    analysisEnvironmentId: v.environmentIds.includes(v.analysisEnvironmentId) ? v.analysisEnvironmentId : (v.environmentIds[0] ?? ""),
    hashAttribute: v.hashAttribute.trim(),
    variations: v.variations.map((x) => ({ key: x.key, name: x.name.trim() || x.key, value: x.value })),
    coverage: v.coverage,
    weights: weightsOf(v),
    conditions: v.conditions.map((c) => ({ ...c, values: [...c.values] })),
    dataSourceId: primary?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID,
    primaryMetricId: v.primaryMetricId,
    secondaryMetricIds: [...v.secondaryMetricIds],
    guardrailMetricIds: [...v.guardrailMetricIds],
    stats: { ...v.stats, sequentialTuning: plan.total ?? v.stats.sequentialTuning },
    plan: {
      mde: v.mdePercent / 100,
      sampleSizePerVariation: plan.perVariation,
      dailyTraffic: Number.isFinite(v.dailyTraffic) ? v.dailyTraffic : null,
    },
    dimensions: [...v.dimensions],
    namespace: v.namespace === null ? null : { ...v.namespace },
  };
};

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

/** Draft page sections, in display order */
export type SectionId = "hypothesis" | "variations" | "targeting" | "metrics" | "plan" | "breakdowns" | "namespace" | "stats";

/** The section whose editor fixes an issue */
export const sectionOf = (issue: Issue): SectionId =>
  issue.field === "namespace"
    ? "namespace"
    : issue.check === "name" || issue.check === "key"
      ? "hypothesis"
      : issue.check === "targeting" || issue.check === "envs" || issue.check === "hash"
        ? "targeting"
        : "variations";

export type AdviceId = "sameValue" | "flagOff" | "guardrail" | "hypothesis" | "plan" | "longPlan";

export interface StartCheck<Id extends string> {
  readonly id: Id;
  readonly section: SectionId;
  readonly message: string;
}

/**
 * The draft page checklist. Blockers keep the experiment from starting; advice never does.
 * `flagOffIn`: names of the experiment's environments where the flag is off
 */
export function startChecks(
  v: ExperimentValues,
  ctx: { readonly valueType: FeatureValueType | undefined; readonly flagOffIn: ReadonlyArray<string>; readonly planDays: number | null; readonly planned: boolean },
): { blockers: Array<StartCheck<CheckId | "primary">>; advice: Array<StartCheck<AdviceId>> } {
  const blockers: Array<StartCheck<CheckId | "primary">> = [];
  for (const issue of draftIssues(v, { isEdit: true, valueType: ctx.valueType }))
    if (!blockers.some((b) => b.id === issue.check))
      blockers.push({ id: issue.check, section: sectionOf(issue), message: i18n.t(`experiments:form.checks.${issue.check}`) });
  if (v.primaryMetricId === null) blockers.push({ id: "primary", section: "metrics", message: i18n.t("experiments:draft.checks.primary") });

  const advice: Array<StartCheck<AdviceId>> = [];
  const control = v.variations[0];
  if (ctx.valueType !== undefined && control !== undefined && v.variations.slice(1).some((x) => x.value === control.value))
    advice.push({ id: "sameValue", section: "variations", message: i18n.t("experiments:draft.checks.sameValue") });
  if (ctx.flagOffIn.length > 0)
    advice.push({ id: "flagOff", section: "targeting", message: i18n.t("experiments:draft.checks.flagOff", { environments: ctx.flagOffIn.join(", ") }) });
  if (v.guardrailMetricIds.length === 0) advice.push({ id: "guardrail", section: "metrics", message: i18n.t("experiments:draft.checks.guardrail") });
  if (v.hypothesis.trim() === "") advice.push({ id: "hypothesis", section: "hypothesis", message: i18n.t("experiments:draft.checks.hypothesis") });
  if (!ctx.planned) advice.push({ id: "plan", section: "plan", message: i18n.t("experiments:draft.checks.plan") });
  else if (ctx.planDays !== null && ctx.planDays > LONG_PLAN_DAYS)
    advice.push({ id: "longPlan", section: "plan", message: i18n.t("experiments:draft.checks.longPlan", { count: ctx.planDays }) });
  return { blockers, advice };
}
