import type { Experiment } from "@furca/core/experiments/Experiment";
import { type Feature, type FeatureRule, ForceRule } from "@furca/core/features/Feature";
import { type ExperimentReach, shadowedBy } from "@furca/core/features/ruleReach";
import type { MetricResult, ResultSnapshot, VariationComparison, Verdict } from "@furca/core/results/ExperimentResult";
import { headlineComparison, isHealthy, regressedGuardrails } from "./verdict";

const DAY = 86_400_000;

/** What the latest analysis says about the primary metric, before any wording */
export interface Assessment {
  /** noData: never analyzed / failed / nobody exposed; unhealthy: SRM or multiple exposures */
  readonly kind: "noData" | "unhealthy" | "noPrimary" | "error" | Verdict;
  readonly primary: MetricResult | undefined;
  /** The comparison the verdict leads with (strongest winner, else worst loser) */
  readonly comparison: VariationComparison | null;
  /** Guardrails that got significantly worse; empty when the data is unhealthy (they can't be trusted) */
  readonly regressions: ReadonlyArray<MetricResult>;
}

export function assess(snapshot: ResultSnapshot | null | undefined): Assessment {
  const none = { primary: undefined, comparison: null, regressions: [] };
  if (snapshot == null || snapshot.status !== "ok" || (snapshot.health?.totalUsers ?? 0) === 0) return { kind: "noData", ...none };
  if (!isHealthy(snapshot.health)) return { kind: "unhealthy", ...none };
  const primary = snapshot.metrics.find((m) => m.role === "primary");
  const regressions = regressedGuardrails(snapshot.metrics);
  const comparison = primary === undefined ? null : headlineComparison(primary);
  if (primary?.error != null) return { kind: "error", primary, comparison: null, regressions };
  if (primary === undefined || comparison === null) return { kind: "noPrimary", primary, comparison: null, regressions };
  return { kind: comparison.verdict, primary, comparison, regressions };
}

/**
 * The stop-panel choice the evidence supports ("ship:<key>" | "rollback" | "inconclusive"): ship a
 * clear winner, roll back a loser or any guardrail regression, otherwise inconclusive. Never ship on
 * less than a day of data
 */
export function recommend(a: Assessment, early: boolean): string {
  if (a.kind === "unhealthy" || a.kind === "noData") return "inconclusive";
  if (a.regressions.length > 0 || a.kind === "losing") return "rollback";
  if (a.kind === "winning" && a.comparison !== null && !early) return `ship:${a.comparison.variationKey}`;
  return "inconclusive";
}

export interface Progress {
  /** 1-based day of the current phase (its last day once stopped) */
  readonly day: number;
  /** Share of the planned sample reached; null without a planned sample size */
  readonly fraction: number | null;
  readonly plannedTotal: number | null;
  /** Days until the planned sample at the observed rate (planned daily traffic on day one); null when unknown, reached or stopped */
  readonly daysLeft: number | null;
  /** Under 24 hours of data: day-of-week and novelty effects make any verdict premature */
  readonly early: boolean;
}

export function progressOf(experiment: Experiment, users: number, computedAt: Date, now: Date): Progress {
  const phase = experiment.phases.at(-1);
  const start = phase?.startedAt.getTime() ?? now.getTime();
  const end = phase?.endedAt?.getTime() ?? now.getTime();
  const per = experiment.plan.sampleSizePerVariation;
  const plannedTotal = per === null ? null : per * experiment.variations.length;
  const fraction = plannedTotal === null || plannedTotal <= 0 ? null : users / plannedTotal;
  const observedDays = (computedAt.getTime() - start) / DAY;
  const rate = observedDays >= 1 ? users / observedDays : experiment.plan.dailyTraffic;
  const daysLeft =
    phase?.endedAt != null || plannedTotal === null || fraction === null || fraction >= 1 || rate === null || rate <= 0
      ? null
      : Math.max(1, Math.ceil((plannedTotal - users) / rate));
  return {
    day: Math.max(1, Math.floor((end - start) / DAY) + 1),
    fraction,
    plannedTotal,
    daysLeft,
    early: observedDays < 1,
  };
}

/** What decides whether an experiment's rule catches everyone (see ruleReach) */
export const reachOf = (x: Experiment): ExperimentReach => {
  const traffic = x.phases.at(-1) ?? x;
  return { status: x.status, conditionCount: traffic.conditions.length, coverage: traffic.coverage, namespaced: x.namespace !== null };
};

/**
 * Rules that serve users today but would never be reached once `experiment` ships: shipping turns
 * its rule into a force rule for everyone matching its targeting, which hides every rule below it
 */
export function shadowedByShipping(
  feature: Feature,
  experiment: Experiment,
  experimentOf: (id: string) => ExperimentReach | undefined,
): Array<{ environmentId: string; rule: FeatureRule }> {
  // Mirrors ExperimentService.stop: same conditions as the current phase, always enabled
  const shipped = new ForceRule({ id: "shipped", description: "", enabled: true, conditions: (experiment.phases.at(-1) ?? experiment).conditions, value: "" });
  return feature.environments
    .filter((env) => experiment.environmentIds.includes(env.environmentId))
    .flatMap((env) => {
      const after = env.rules.map((r) => (r._tag === "experiment" && r.experimentId === experiment.id ? shipped : r));
      const was = shadowedBy(env.rules, experimentOf);
      const will = shadowedBy(after, experimentOf);
      return after.flatMap((rule, i) => (will[i] !== null && was[i] === null ? [{ environmentId: env.environmentId, rule }] : []));
    });
}
