import {
  type Attributes,
  chooseVariation,
  type Evaluation,
  evaluate,
  evaluateConditions,
  getBucketRanges,
  hash,
  inNamespace,
  type PayloadRule,
  type SdkPayload,
} from "@furca/sdk";
import { i18n } from "~/i18n";
import { conditionsSummary } from "../targeting/summary";

export interface TraceStep {
  /** Index in the payload's rule list */
  readonly index: number;
  readonly rule: PayloadRule;
  readonly matched: boolean;
  /** Plain-language reason, e.g. "Needs country is one of JP, US (has US)" */
  readonly reason: string;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : String(v));

function step(rule: PayloadRule, attributes: Attributes, savedGroups: SdkPayload["savedGroups"]): { matched: boolean; reason: string } {
  const failing = rule.conditions.find((c) => !evaluateConditions([c], attributes, savedGroups));
  if (failing !== undefined) {
    // Group conditions have no attribute of their own to show
    if (failing.operator === "in_group" || failing.operator === "not_in_group")
      return { matched: false, reason: i18n.t("flags:simulate.needsGroup", { condition: conditionsSummary([failing]) }) };
    const has = Object.hasOwn(attributes, failing.attribute) ? attributes[failing.attribute] : undefined;
    return {
      matched: false,
      reason: i18n.t("flags:simulate.needs", {
        condition: conditionsSummary([failing]),
        actual: has === undefined || has === null ? i18n.t("flags:simulate.notSet") : i18n.t("flags:simulate.has", { value: show(has) }),
      }),
    };
  }
  const who = rule.conditions.length === 0 ? i18n.t("targeting:summary.everyone") : i18n.t("flags:simulate.conditionsMatch");
  if (rule.type === "force") return { matched: true, reason: who };
  if (rule.type !== "rollout" && rule.type !== "experiment") return { matched: false, reason: i18n.t("flags:simulate.unknownType") };
  const raw = Object.hasOwn(attributes, rule.hashAttribute) ? attributes[rule.hashAttribute] : undefined;
  const id = raw === undefined || raw === null ? "" : String(raw);
  if (id === "") return { matched: false, reason: i18n.t("flags:simulate.noHashAttribute", { attribute: rule.hashAttribute }) };
  if (rule.type === "experiment" && rule.namespace && !inNamespace(id, rule.namespace))
    return { matched: false, reason: i18n.t("flags:simulate.outsideNamespace", { namespace: rule.namespace[0] }) };
  const n = hash(rule.seed, id);
  const bucket = n.toFixed(4);
  if (rule.type === "rollout") {
    const percent = pct(rule.coverage);
    return n < rule.coverage
      ? { matched: true, reason: i18n.t("flags:simulate.inRollout", { percent, bucket }) }
      : { matched: false, reason: i18n.t("flags:simulate.outsideRollout", { percent, bucket }) };
  }
  const v = rule.variations[chooseVariation(n, getBucketRanges(rule.variations.length, rule.coverage, rule.weights))];
  return v === undefined
    ? { matched: false, reason: i18n.t("flags:simulate.outsideExperiment", { bucket }) }
    : { matched: true, reason: i18n.t("flags:simulate.assigned", { variation: v.key, bucket }) };
}

/** Evaluates exactly like the SDK and explains each rule it looked at, up to the one that matched */
export function traceEvaluation(
  payload: SdkPayload | null,
  key: string,
  attributes: Attributes,
): { evaluation: Evaluation; steps: ReadonlyArray<TraceStep> } {
  const evaluation = evaluate(payload, key, attributes);
  const rules = payload?.features[key]?.rules ?? [];
  const steps: Array<TraceStep> = [];
  for (const [index, rule] of rules.entries()) {
    const s = step(rule, attributes, payload?.savedGroups);
    steps.push({ index, rule, ...s });
    if (s.matched) break;
  }
  return { evaluation, steps };
}

/** The parts of a saved flag rule needed to find it again in the published payload */
export type SavedRule =
  | { readonly _tag: "force"; readonly id: string; readonly enabled: boolean; readonly conditions: ReadonlyArray<unknown>; readonly value: string }
  | { readonly _tag: "rollout"; readonly id: string; readonly enabled: boolean; readonly seed: string }
  | { readonly _tag: "experiment"; readonly id: string; readonly enabled: boolean; readonly experimentId: string };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/**
 * Maps each payload rule index to the saved rule id it came from. The payload leaves out disabled
 * rules (and inactive experiments), so rules are matched in order by seed / experiment key / content
 */
export function alignRules(
  payloadRules: ReadonlyArray<PayloadRule>,
  saved: ReadonlyArray<SavedRule>,
  experimentKeyById: ReadonlyMap<string, string>,
): Array<string | null> {
  let j = 0;
  return payloadRules.map((p) => {
    for (let k = j; k < saved.length; k++) {
      const s = saved[k]!;
      const match =
        (s._tag === "rollout" && p.type === "rollout" && p.seed === s.seed) ||
        (s._tag === "experiment" && p.type === "experiment" && experimentKeyById.get(s.experimentId) === p.key) ||
        (s._tag === "force" && p.type === "force" && sameJson(p.conditions, s.conditions) && sameJson(p.value, parse(s.value)));
      if (match) {
        j = k + 1;
        return s.id;
      }
    }
    return null;
  });
}
