import type { ExperimentStatus } from "../experiments/Experiment";
import type { FeatureRule } from "./Feature";

/** What decides whether an experiment rule catches every user that reaches it */
export interface ExperimentReach {
  readonly status: ExperimentStatus;
  readonly conditionCount: number;
  readonly coverage: number;
  readonly namespaced: boolean;
}

/** The reach of an experiment (running experiments keep their current traffic on the experiment itself) */
export const experimentReach = (e: {
  readonly status: ExperimentStatus;
  readonly conditions: ReadonlyArray<unknown>;
  readonly coverage: number;
  readonly namespace: unknown;
}): ExperimentReach => ({ status: e.status, conditionCount: e.conditions.length, coverage: e.coverage, namespaced: e.namespace !== null });

/** True when every user reaching the rule is served by it, so later rules never run */
const catchesEveryone = (rule: FeatureRule, experimentOf: (id: string) => ExperimentReach | undefined): boolean => {
  if (!rule.enabled) return false;
  switch (rule._tag) {
    case "force":
      return rule.conditions.length === 0;
    case "rollout":
      return rule.conditions.length === 0 && rule.coverage >= 1;
    case "experiment": {
      const x = experimentOf(rule.experimentId);
      return x !== undefined && x.status === "running" && x.conditionCount === 0 && x.coverage >= 1 && !x.namespaced;
    }
  }
};

/** Whether a rule serves anyone at all: disabled rules and experiments that aren't running don't */
const isLive = (rule: FeatureRule, experimentOf: (id: string) => ExperimentReach | undefined): boolean =>
  rule.enabled && (rule._tag !== "experiment" || experimentOf(rule.experimentId)?.status === "running");

/**
 * For each rule, the index of an earlier rule that catches every user first (so this one never
 * serves anyone), or null. Rules that serve nobody anyway (disabled, experiment not running) are null
 */
export function shadowedBy(
  rules: ReadonlyArray<FeatureRule>,
  experimentOf: (id: string) => ExperimentReach | undefined,
): Array<number | null> {
  let blocker: number | null = null;
  return rules.map((rule, i) => {
    const shadow = blocker !== null && isLive(rule, experimentOf) ? blocker : null;
    if (blocker === null && catchesEveryone(rule, experimentOf)) blocker = i;
    return shadow;
  });
}
