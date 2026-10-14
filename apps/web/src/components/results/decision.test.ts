import { describe, expect, it } from "bun:test";
import type { Experiment } from "@furca/core/experiments/Experiment";
import { ExperimentRule, type Feature, ForceRule, RolloutRule } from "@furca/core/features/Feature";
import type { ExperimentReach } from "@furca/core/features/ruleReach";
import type { ResultSnapshot, Verdict } from "@furca/core/results/ExperimentResult";
import { assess, progressOf, recommend, shadowedByShipping } from "./decision";

const DAY = 86_400_000;
const t0 = new Date("2026-10-01T00:00:00Z");
const at = (days: number) => new Date(t0.getTime() + days * DAY);

const comparison = (variationKey: string, verdict: Verdict, lift = 0.03) => ({
  variationKey,
  verdict,
  lift,
  ci: [lift - 0.02, lift + 0.02] as const,
  absoluteDiff: null,
  pValue: verdict === "neutral" ? 0.4 : 0.01,
  chanceToWin: null,
  message: null,
});

const snapshot = (primary: Verdict, guardrail: Verdict = "neutral", healthy = true) =>
  ({
    status: "ok",
    computedAt: at(5),
    health: { totalUsers: 1000, srm: { ok: healthy, pValue: 0.5, observed: [500, 500], expectedWeights: [0.5, 0.5] }, multipleExposureUsers: 0, multipleExposuresOk: true },
    metrics: [
      { metricId: "p", role: "primary", error: null, comparisons: [comparison("b", primary)] },
      { metricId: "g", role: "guardrail", error: null, comparisons: [comparison("b", guardrail, -0.05)] },
    ],
  }) as unknown as ResultSnapshot;

describe("recommend", () => {
  it("ships a clear winner when no guardrail regressed", () => {
    expect(recommend(assess(snapshot("winning")), false)).toBe("ship:b");
  });

  it("rolls back a winner whose guardrail regressed, and any loser", () => {
    expect(recommend(assess(snapshot("winning", "losing")), false)).toBe("rollback");
    expect(recommend(assess(snapshot("losing")), false)).toBe("rollback");
  });

  it("calls no difference, too little data, early data and unhealthy data inconclusive", () => {
    expect(recommend(assess(snapshot("neutral")), false)).toBe("inconclusive");
    expect(recommend(assess(snapshot("inconclusive")), false)).toBe("inconclusive");
    expect(recommend(assess(snapshot("winning")), true)).toBe("inconclusive");
    expect(recommend(assess(snapshot("winning", "losing", false)), false)).toBe("inconclusive");
    expect(recommend(assess(null), false)).toBe("inconclusive");
  });

  it("ignores guardrail regressions in unhealthy data", () => {
    expect(assess(snapshot("winning", "losing", false))).toMatchObject({ kind: "unhealthy", regressions: [] });
  });
});

const experiment = (plan: { sampleSizePerVariation: number | null; dailyTraffic: number | null }, endedAt: Date | null = null) =>
  ({
    id: "x",
    status: endedAt === null ? "running" : "stopped",
    variations: [{ key: "a" }, { key: "b" }],
    plan: { mde: 0.05, ...plan },
    phases: [{ startedAt: t0, endedAt, coverage: 1, conditions: [] }],
    environmentIds: ["prod"],
    conditions: [],
    coverage: 1,
    namespace: null,
  }) as unknown as Experiment;

describe("progressOf", () => {
  it("projects the days left from the observed daily rate", () => {
    // 2 arms x 5,000 = 10,000 planned; 3,800 users in 2 days -> 1,900/day -> 6,200 left = 4 days
    const p = progressOf(experiment({ sampleSizePerVariation: 5000, dailyTraffic: 500 }), 3800, at(2), at(2.5));
    expect(p).toMatchObject({ day: 3, plannedTotal: 10000, daysLeft: 4, early: false });
    expect(p.fraction).toBeCloseTo(0.38);
  });

  it("uses the planned daily traffic and flags early data during the first day", () => {
    const p = progressOf(experiment({ sampleSizePerVariation: 5000, dailyTraffic: 1000 }), 200, at(0.25), at(0.3));
    expect(p).toMatchObject({ day: 1, daysLeft: 10, early: true });
  });

  it("has no estimate without a plan, once the sample is reached, or after stopping", () => {
    expect(progressOf(experiment({ sampleSizePerVariation: null, dailyTraffic: 1000 }), 500, at(2), at(2))).toMatchObject({ fraction: null, daysLeft: null });
    expect(progressOf(experiment({ sampleSizePerVariation: 100, dailyTraffic: null }), 300, at(2), at(2)).daysLeft).toBeNull();
    expect(progressOf(experiment({ sampleSizePerVariation: 5000, dailyTraffic: null }, at(4)), 300, at(2), at(9))).toMatchObject({ day: 5, daysLeft: null });
  });
});

describe("shadowedByShipping", () => {
  const reach: Record<string, ExperimentReach> = {
    x: { status: "running", conditionCount: 0, coverage: 0.5, namespaced: false },
    other: { status: "running", conditionCount: 0, coverage: 0.5, namespaced: false },
  };
  const feature = (rules: Feature["environments"][number]["rules"]) =>
    ({ environments: [{ environmentId: "prod", enabled: true, rules }, { environmentId: "dev", enabled: true, rules }] }) as unknown as Feature;
  const rollout = new RolloutRule({ id: "r", description: "", enabled: true, conditions: [], value: "true", coverage: 0.1, hashAttribute: "id", seed: "s" });

  it("reports rules below an untargeted experiment that shipping would hide, only where it runs", () => {
    const hidden = shadowedByShipping(
      feature([new ExperimentRule({ id: "1", enabled: true, experimentId: "x" }), new ExperimentRule({ id: "2", enabled: true, experimentId: "other" }), rollout]),
      experiment({ sampleSizePerVariation: null, dailyTraffic: null }),
      (id) => reach[id],
    );
    expect(hidden.map((h) => [h.environmentId, h.rule.id])).toEqual([
      ["prod", "2"],
      ["prod", "r"],
    ]);
  });

  it("reports nothing that was already hidden before shipping", () => {
    const force = new ForceRule({ id: "f", description: "", enabled: true, conditions: [], value: "true" });
    expect(shadowedByShipping(feature([force, new ExperimentRule({ id: "1", enabled: true, experimentId: "x" }), rollout]), experiment({ sampleSizePerVariation: null, dailyTraffic: null }), (id) => reach[id])).toEqual([]);
  });
});
