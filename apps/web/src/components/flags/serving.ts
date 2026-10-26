import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature, FeatureRule } from "@furca/core/features/Feature";
import { experimentReach, shadowedBy } from "@furca/core/features/ruleReach";
import { i18n } from "~/i18n";

/** A JSON-encoded value as short plain text: true, "blue", {"a":1}… */
export const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);

/**
 * What SDKs get from a flag in one environment, in words: "SDKs return the fallback in your code",
 * "Everyone gets false", "Users matching a rule get true, everyone else false". Experiment rules
 * count only while their experiment runs (unknown experiments count as running)
 */
export function servingText(feature: Feature, environmentId: string, experiments?: ReadonlyMap<string, Experiment>): string {
  const config = feature.environments.find((e) => e.environmentId === environmentId);
  if (config?.enabled !== true) return i18n.t(($) => $.serving.off, { ns: "flags" });
  const live = config.rules.filter(
    (r) => r.enabled && (r._tag !== "experiment" || (experiments?.get(r.experimentId)?.status ?? "running") === "running"),
  );
  // A rule that serves everyone (e.g. a shipped variation) replaces the default for everyone below it
  const catchAll = shadowedRules([...live, { _tag: "force", enabled: true, conditions: [] }], experiments ?? new Map()).at(-1) ?? null;
  const blocker = catchAll === null ? undefined : live[catchAll];
  const [rules, fallback] = blocker !== undefined && blocker._tag !== "experiment" ? [live.slice(0, catchAll!), blocker.value] : [live, feature.defaultValue];
  const value = short(fallback);
  if (rules.length === 0) return i18n.t(($) => $.serving.everyone, { ns: "flags", value });
  const ruleValues = new Set(rules.map((r) => (r._tag === "experiment" ? null : r.value)));
  const [only] = ruleValues;
  return ruleValues.size === 1 && only != null && only !== fallback
    ? i18n.t(($) => $.serving.rules, { ns: "flags", ruleValue: short(only), value })
    : i18n.t(($) => $.serving.mixed, { ns: "flags", value });
}

/** "On · everyone gets false" / "Off · SDKs return the fallback in your code" */
export const stateAndServing = (feature: Feature, environmentId: string, experiments?: ReadonlyMap<string, Experiment>) =>
  i18n.t(($) => $.serving.withState, { ns: "flags",
    state: feature.environments.find((e) => e.environmentId === environmentId)?.enabled === true ? i18n.t(($) => $.shared.on, { ns: "flags" }) : i18n.t(($) => $.shared.off, { ns: "flags" }),
    serving: servingText(feature, environmentId, experiments),
  });

/** A boolean flag that is on with no enabled rules and default false serves false to everyone: probably not what "on" meant */
export const servesOnlyFalse = (feature: Feature, environmentId: string) => {
  const config = feature.environments.find((e) => e.environmentId === environmentId);
  return feature.valueType === "boolean" && feature.defaultValue === "false" && config?.enabled === true && !config.rules.some((r) => r.enabled);
};

/** For each rule, the index of an earlier rule that already serves everyone (so this one never runs), or null */
export const shadowedRules = (rules: ReadonlyArray<unknown>, experiments: ReadonlyMap<string, Experiment>) =>
  shadowedBy(rules as unknown as ReadonlyArray<FeatureRule>, (id) => {
    const x = experiments.get(id);
    return x === undefined ? undefined : experimentReach(x);
  });
