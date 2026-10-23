import { describe, expect, test } from "bun:test";
import {
  chooseVariation,
  evaluate,
  evaluateConditions,
  getBucketRanges,
  hash,
  inNamespace,
  type ConditionOperator,
  type ExperimentPayloadRule,
  type PayloadFeature,
  type PayloadRule,
  type SdkPayload,
} from "../src/index.ts";

// Our own inputs; expected values computed once with @growthbook/growthbook 1.8.0's hash / inNamespace /
// getBucketRanges / chooseVariation, so a match means GrowthBook buckets the same users the same way
const GB_HASH_V2: Array<[string, string, number]> = [
  ["furca", "user-1", 0.0463],
  ["furca", "user-2", 0.2168],
  ["checkout", "42", 0.4063],
  ["checkout", "4242424242", 0.0146],
  ["新しい料金", "ユーザー", 0.1383],
  ["emoji-🙂", "👩‍💻", 0.193],
  ["", "anonymous", 0.6947],
  ["a b\tc", "line\nbreak", 0.4721],
];
const GB_HASH_V1: Array<[string, string, number]> = [
  ["", "user-1", 0.5],
  ["", "user-2", 0.357],
  ["checkout", "42", 0.135],
  ["x", "y", 0.444],
  ["新", "ユーザー", 0.359],
  ["", "👩‍💻", 0.882],
  ["long-seed-0123456789", "id-9876543210", 0.146],
];
// [id, namespace, expected]
const GB_IN_NAMESPACE: Array<[string, [string, number, number], boolean]> = [
  ["user-1", ["pricing", 0, 0.5], true],
  ["user-1", ["pricing", 0.5, 1], false],
  ["user-1", ["onboarding", 0, 0.3], true],
  ["user-1", ["onboarding", 0.3, 1], false],
  ["user-2", ["pricing", 0, 0.5], true],
  ["user-2", ["pricing", 0.5, 1], false],
  ["user-2", ["onboarding", 0, 0.3], false],
  ["user-2", ["onboarding", 0.3, 1], true],
  ["user-3", ["pricing", 0, 0.5], true],
  ["user-3", ["pricing", 0.5, 1], false],
  ["user-3", ["onboarding", 0, 0.3], true],
  ["user-3", ["onboarding", 0.3, 1], false],
  ["user-4", ["pricing", 0, 0.5], false],
  ["user-4", ["pricing", 0.5, 1], true],
  ["user-4", ["onboarding", 0, 0.3], true],
  ["user-4", ["onboarding", 0.3, 1], false],
];
const GB_BUCKET_RANGES: Array<[string, [number, number, number[] | null], Array<[number, number]>]> = [
  ["even 3-way", [3, 1, null], [[0, 0.333333], [0.333333, 0.666667], [0.666667, 1]]],
  ["half coverage, 3-way", [3, 0.5, null], [[0, 0.166667], [0.333333, 0.5], [0.666667, 0.833333]]],
  ["zero coverage", [3, 0, null], [[0, 0], [0.333333, 0.333333], [0.666667, 0.666667]]],
  ["5 variations", [5, 1, null], [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1]]],
  ["uneven weights", [2, 1, [0.3, 0.7]], [[0, 0.3], [0.3, 1]]],
  ["uneven weights, 4 variations", [4, 1, [0.1, 0.2, 0.3, 0.4]], [[0, 0.1], [0.1, 0.3], [0.3, 0.6], [0.6, 1]]],
  ["uneven weights, reduced coverage", [3, 0.6, [0.5, 0.25, 0.25]], [[0, 0.3], [0.5, 0.65], [0.75, 0.9]]],
  ["negative coverage", [3, -1, null], [[0, 0], [0.333333, 0.333333], [0.666667, 0.666667]]],
  ["coverage above 1", [3, 2, null], [[0, 0.333333], [0.333333, 0.666667], [0.666667, 1]]],
  ["weights sum below 1", [3, 1, [0.2, 0.2, 0.2]], [[0, 0.333333], [0.333333, 0.666667], [0.666667, 1]]],
  ["weights sum above 1", [2, 1, [0.9, 0.9]], [[0, 0.5], [0.5, 1]]],
  ["weights length mismatch", [3, 1, [0.5, 0.5]], [[0, 0.333333], [0.333333, 0.666667], [0.666667, 1]]],
  ["weights sum almost 1", [3, 1, [0.2, 0.3, 0.4999]], [[0, 0.2], [0.2, 0.5], [0.5, 0.9999]]],
];
const THIRDS: Array<[number, number]> = [[0, 0.333333], [0.333333, 0.666667], [0.666667, 1]];
const GAPPED: Array<[number, number]> = [[0, 0.2], [0.4, 0.6]];
const GB_CHOOSE_VARIATION: Array<[string, number, Array<[number, number]>, number]> = [
  ["three-way, 0.1", 0.1, THIRDS, 0],
  ["three-way, 0.5", 0.5, THIRDS, 1],
  ["three-way, 0.9", 0.9, THIRDS, 2],
  ["three-way, start of 2nd range", 0.333333, THIRDS, 1],
  ["gapped, 0.1", 0.1, GAPPED, 0],
  ["gapped, end of 1st range", 0.2, GAPPED, -1],
  ["gapped, 0.3", 0.3, GAPPED, -1],
  ["gapped, start of 2nd range", 0.4, GAPPED, 1],
  ["gapped, 0.7", 0.7, GAPPED, -1],
  ["empty range skipped", 0.3, [[0, 0.3], [0.3, 0.3], [0.3, 1]], 2],
  ["1 is outside every range", 1, [[0, 0.5], [0.5, 1]], -1],
];

const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("GrowthBook compatibility", () => {
  test.each(GB_HASH_V2)("hash(%p, %p) = %p", (seed, value, expected) => {
    expect(hash(seed, value)).toBe(expected);
  });

  test.each(GB_HASH_V1)("hash(%p, %p, 1) = %p", (seed, value, expected) => {
    expect(hash(seed, value, 1)).toBe(expected);
  });

  test.each(GB_IN_NAMESPACE)("inNamespace(%p, %p) = %p", (id, namespace, expected) => {
    expect(inNamespace(id, namespace)).toBe(expected);
  });

  // Namespace membership from GB_IN_NAMESPACE / @growthbook/growthbook 1.8.0 inNamespace
  test.each([
    ["inside the namespace range enters", "user-1", ["pricing", 0, 0.5], "experiment"],
    ["outside the namespace range falls through", "user-4", ["pricing", 0, 0.5], "force"],
    ["inside a 1% namespace enters", "user-54", ["tiny", 0, 0.01], "experiment"],
    ["outside a 1% namespace falls through", "user-2", ["tiny", 0, 0.01], "force"],
  ] as const)("experiment namespace: %s", (_, id, namespace, source) => {
    const payload = feature({
      defaultValue: 0,
      rules: [{ ...experiment({ values: [0, 1, 2, 3] }), namespace }, { type: "force", conditions: [], value: 3 }],
    });
    expect(evaluate(payload, "f", { id }).source).toBe(source);
  });

  test.each(GB_BUCKET_RANGES)("getBucketRanges: %s", (_, [n, coverage, weights], expected) => {
    expect(getBucketRanges(n, coverage, weights ?? undefined).map((r) => r.map(round))).toEqual(expected);
  });

  test.each(GB_CHOOSE_VARIATION)("chooseVariation: %s", (_, n, ranges, expected) => {
    expect(chooseVariation(n, ranges)).toBe(expected);
  });

  // seed "furca-seed": @growthbook/growthbook 1.8.0 puts user-1 in variation 0 and user-2 in variation 1
  test.each([
    ["full coverage", "user-1", 1, 0],
    ["full coverage", "user-2", 1, 1],
    ["99% coverage", "user-1", 0.99, 0],
    ["99% coverage", "user-2", 0.99, 1],
  ] as const)("experiment with seed: %s, %s", (_, id, coverage, expected) => {
    const payload = feature({
      defaultValue: -1,
      rules: [experiment({ seed: "furca-seed", coverage, weights: [0.5, 0.5], values: [0, 1] })],
    });
    expect(evaluate(payload, "f", { id }).value).toBe(expected);
  });
});

// --- helpers -----------------------------------------------------------------

function feature(f: PayloadFeature): SdkPayload {
  return { version: 1, environment: "production", generatedAt: "2026-01-01T00:00:00Z", features: { f } };
}

function experiment(o: { seed?: string; coverage?: number; weights?: number[]; values?: unknown[]; conditions?: PayloadRule["conditions"] }): ExperimentPayloadRule {
  const values = o.values ?? ["a", "b"];
  return {
    type: "experiment",
    key: "exp",
    conditions: o.conditions ?? [],
    coverage: o.coverage ?? 1,
    hashAttribute: "id",
    seed: o.seed ?? "exp",
    phase: 0,
    variations: values.map((value, i) => ({ key: `v${i}`, value })),
    weights: o.weights ?? values.map(() => 1 / values.length),
  };
}

const cond = (attribute: string, operator: ConditionOperator, ...values: string[]) => [{ attribute, operator, values }];
const match = (operator: ConditionOperator, attr: unknown, ...values: string[]) =>
  evaluateConditions(cond("a", operator, ...values), attr === undefined ? {} : { a: attr });

// --- conditions ------------------------------------------------------------------

describe("operators", () => {
  test("eq / neq compare String(attr)", () => {
    expect(match("eq", "x", "x")).toBe(true);
    expect(match("eq", 5, "5")).toBe(true);
    expect(match("eq", true, "true")).toBe(true);
    expect(match("eq", "X", "x")).toBe(false);
    expect(match("neq", "x", "x")).toBe(false);
    expect(match("neq", "y", "x")).toBe(true);
  });

  test("in / not_in", () => {
    expect(match("in", "jp", "us", "jp")).toBe(true);
    expect(match("in", "de", "us", "jp")).toBe(false);
    expect(match("in", 3, "1", "3")).toBe(true);
    expect(match("not_in", "de", "us", "jp")).toBe(true);
    expect(match("not_in", "jp", "us", "jp")).toBe(false);
  });

  test("string operators", () => {
    expect(match("contains", "hello@furca.dev", "@furca")).toBe(true);
    expect(match("contains", "hello@x.dev", "@furca")).toBe(false);
    expect(match("contains", "hello@x.dev", "@furca", "@x")).toBe(true);
    expect(match("not_contains", "hello@x.dev", "@furca")).toBe(true);
    expect(match("not_contains", "hello@furca.dev", "@furca")).toBe(false);
    expect(match("starts_with", "/admin/x", "/admin")).toBe(true);
    expect(match("starts_with", "/x/admin", "/admin")).toBe(false);
    expect(match("ends_with", "a@furca.dev", ".dev")).toBe(true);
    expect(match("ends_with", "a@furca.com", ".dev")).toBe(false);
  });

  test("regex, invalid regex never matches", () => {
    expect(match("regex", "user-123", "^user-\\d+$")).toBe(true);
    expect(match("regex", "admin-1", "^user-\\d+$")).toBe(false);
    expect(match("regex", "anything", "([")).toBe(false);
    expect(match("regex", "anything")).toBe(false);
  });

  test("numeric operators, NaN never matches", () => {
    expect(match("gt", 10, "9")).toBe(true);
    expect(match("gt", "10", "9")).toBe(true); // numeric, not lexicographic
    expect(match("gt", 9, "9")).toBe(false);
    expect(match("gte", 9, "9")).toBe(true);
    expect(match("lt", 1.5, "2")).toBe(true);
    expect(match("lte", 2, "2")).toBe(true);
    expect(match("lte", 3, "2")).toBe(false);
    expect(match("gt", "abc", "1")).toBe(false);
    expect(match("lt", "abc", "1")).toBe(false);
    expect(match("gt", 5, "abc")).toBe(false);
    expect(match("lt", "", "1")).toBe(false); // "" is not 0
    expect(match("gte", 0, "")).toBe(false);
  });

  test("semver with prerelease ordering", () => {
    // semver.org §11 example ordering
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "2.0.0",
      "10.0.0",
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        const [a, b] = [ordered[i]!, ordered[j]!];
        expect([a, b, match("semver_gt", a, b)]).toEqual([a, b, i > j]);
        expect([a, b, match("semver_gte", a, b)]).toEqual([a, b, i >= j]);
        expect([a, b, match("semver_lt", a, b)]).toEqual([a, b, i < j]);
        expect([a, b, match("semver_lte", a, b)]).toEqual([a, b, i <= j]);
      }
    }
    expect(match("semver_gte", "v1.2.3", "1.2.3")).toBe(true);
    expect(match("semver_gt", "1.2.3+build.5", "1.2.2")).toBe(true);
    expect(match("semver_gte", "1.2.3+build.5", "1.2.3")).toBe(true); // build metadata ignored
    expect(match("semver_gte", "1.2", "1.2.0")).toBe(true); // missing patch = 0
    expect(match("semver_gt", "not-a-version", "1.0.0")).toBe(false);
    expect(match("semver_lt", "not-a-version", "1.0.0")).toBe(false);
    expect(match("semver_lt", "1.0.0", "garbage")).toBe(false);
  });

  test("exists / not_exists", () => {
    expect(match("exists", "x")).toBe(true);
    expect(match("exists", "")).toBe(true);
    expect(match("exists", 0)).toBe(true);
    expect(match("exists", undefined)).toBe(false);
    expect(match("exists", null)).toBe(false);
    expect(match("not_exists", undefined)).toBe(true);
    expect(match("not_exists", null)).toBe(true);
    expect(match("not_exists", "x")).toBe(false);
  });

  test("missing attribute: only negative operators match", () => {
    const negatives = new Set<ConditionOperator>(["neq", "not_in", "not_contains", "not_exists"]);
    const all: ConditionOperator[] = [
      "eq", "neq", "in", "not_in", "contains", "not_contains", "starts_with", "ends_with", "regex",
      "gt", "gte", "lt", "lte", "semver_gt", "semver_gte", "semver_lt", "semver_lte", "exists", "not_exists",
    ];
    for (const op of all) {
      expect([op, match(op, undefined, ".*")]).toEqual([op, negatives.has(op)]);
      expect([op, match(op, null, ".*")]).toEqual([op, negatives.has(op)]);
    }
  });

  test("conditions are AND-ed; empty list matches; prototype keys are not attributes", () => {
    const conditions = [...cond("country", "eq", "jp"), ...cond("plan", "in", "pro", "team")];
    expect(evaluateConditions(conditions, { country: "jp", plan: "pro" })).toBe(true);
    expect(evaluateConditions(conditions, { country: "jp", plan: "free" })).toBe(false);
    expect(evaluateConditions([], {})).toBe(true);
    expect(evaluateConditions(cond("toString", "exists"), {})).toBe(false);
  });
});

describe("saved groups", () => {
  const savedGroups: SdkPayload["savedGroups"] = {
    beta: { type: "list", attribute: "email", values: ["a@x.dev", "42"] },
    japan: { type: "condition", conditions: cond("country", "eq", "jp") },
    nested: { type: "condition", conditions: cond("", "in_group", "japan") },
  };
  const group = (operator: "in_group" | "not_in_group", id: string, attributes: Record<string, unknown>) =>
    evaluateConditions(cond("ignored", operator, id), attributes, savedGroups);

  test("list group: String(attribute) is one of the values", () => {
    expect(group("in_group", "beta", { email: "a@x.dev" })).toBe(true);
    expect(group("in_group", "beta", { email: 42 })).toBe(true);
    expect(group("in_group", "beta", { email: "b@x.dev" })).toBe(false);
    expect(group("in_group", "beta", {})).toBe(false);
    expect(group("not_in_group", "beta", { email: "a@x.dev" })).toBe(false);
    expect(group("not_in_group", "beta", {})).toBe(true);
  });

  test("condition group: all of its conditions match", () => {
    expect(group("in_group", "japan", { country: "jp" })).toBe(true);
    expect(group("in_group", "japan", { country: "us" })).toBe(false);
    expect(group("not_in_group", "japan", { country: "us" })).toBe(true);
  });

  test("missing group: in_group false, not_in_group true; nested group references never resolve", () => {
    expect(group("in_group", "deleted", { email: "a@x.dev" })).toBe(false);
    expect(group("not_in_group", "deleted", {})).toBe(true);
    expect(group("in_group", "toString", {})).toBe(false);
    expect(evaluateConditions(cond("", "in_group", "beta"), { email: "a@x.dev" })).toBe(false); // no savedGroups passed
    expect(group("in_group", "nested", { country: "jp" })).toBe(false);
  });

  test("evaluate resolves groups from payload.savedGroups", () => {
    const p: SdkPayload = {
      ...feature({ defaultValue: "off", rules: [{ type: "force", conditions: cond("", "in_group", "beta"), value: "on" }] }),
      savedGroups,
    };
    expect(evaluate(p, "f", { email: "a@x.dev" }).value).toBe("on");
    expect(evaluate(p, "f", { email: "c@x.dev" }).value).toBe("off");
  });
});

// --- rules -----------------------------------------------------------------------

describe("evaluate", () => {
  test("missing feature → unknown, null", () => {
    expect(evaluate(feature({ defaultValue: true, rules: [] }), "nope", {})).toEqual({
      key: "nope",
      value: null,
      source: "unknown",
      ruleIndex: -1,
      experiment: null,
    });
    expect(evaluate(null, "f", {}).source).toBe("unknown");
    expect(evaluate(feature({ defaultValue: true, rules: [] }), "constructor", {}).source).toBe("unknown");
  });

  test("no matching rule → default", () => {
    const p = feature({ defaultValue: "off", rules: [{ type: "force", conditions: cond("x", "eq", "1"), value: "on" }] });
    expect(evaluate(p, "f", {})).toMatchObject({ value: "off", source: "default", ruleIndex: -1 });
  });

  test("first applicable rule wins, top to bottom", () => {
    const p = feature({
      defaultValue: 0,
      rules: [
        { type: "force", conditions: cond("country", "eq", "us"), value: 1 },
        { type: "force", conditions: cond("plan", "eq", "pro"), value: 2 },
        { type: "force", conditions: [], value: 3 },
      ],
    });
    expect(evaluate(p, "f", { country: "us", plan: "pro" })).toMatchObject({ value: 1, source: "force", ruleIndex: 0 });
    expect(evaluate(p, "f", { country: "jp", plan: "pro" })).toMatchObject({ value: 2, ruleIndex: 1 });
    expect(evaluate(p, "f", {})).toMatchObject({ value: 3, ruleIndex: 2 });
  });

  test("rollout: hash < coverage serves value, otherwise falls through", () => {
    const seed = "seed";
    const rollout = (coverage: number): PayloadRule => ({ type: "rollout", conditions: [], value: true, coverage, hashAttribute: "id", seed });
    const p = (coverage: number) => feature({ defaultValue: false, rules: [rollout(coverage), { type: "force", conditions: [], value: "next" }] });
    // hash("seed", "a") = 0.0505
    expect(evaluate(p(0.06), "f", { id: "a" })).toMatchObject({ value: true, source: "rollout", ruleIndex: 0 });
    expect(evaluate(p(0.0505), "f", { id: "a" })).toMatchObject({ value: "next", source: "force", ruleIndex: 1 });
    expect(evaluate(p(1), "f", {})).toMatchObject({ value: "next" }); // missing hash attribute → skip
    expect(evaluate(p(1), "f", { id: "" })).toMatchObject({ value: "next" });
    expect(evaluate(p(1), "f", { id: 42 })).toMatchObject({ value: true }); // stringified
    expect(evaluate(p(0), "f", { id: "a" })).toMatchObject({ value: "next" });
  });

  test("rollout coverage distribution ±2%", () => {
    for (const coverage of [0.1, 0.3, 0.5, 0.9]) {
      const p = feature({
        defaultValue: false,
        rules: [{ type: "rollout", conditions: [], value: true, coverage, hashAttribute: "id", seed: `flag-${coverage}` }],
      });
      let on = 0;
      for (let i = 0; i < 10_000; i++) if (evaluate(p, "f", { id: `user-${i}` }).value === true) on++;
      expect(Math.abs(on / 10_000 - coverage)).toBeLessThan(0.02);
    }
  });

  test("experiment: assignment, weights, coverage and fall-through", () => {
    const p = feature({
      defaultValue: "default",
      rules: [experiment({ coverage: 0.5, weights: [0.2, 0.8], values: ["control", "treatment"] }), { type: "force", conditions: [], value: "after" }],
    });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const ev = evaluate(p, "f", { id: `u${i}` });
      counts[String(ev.value)] = (counts[String(ev.value)] ?? 0) + 1;
      if (ev.source === "experiment") {
        expect(ev.ruleIndex).toBe(0);
        expect(ev.experiment).toEqual({ key: "exp", variationKey: ev.value === "control" ? "v0" : "v1" });
      } else {
        expect(ev).toMatchObject({ source: "force", ruleIndex: 1, experiment: null });
      }
    }
    expect(Math.abs(counts.control! / 10_000 - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(counts.treatment! / 10_000 - 0.4)).toBeLessThan(0.02);
    expect(Math.abs(counts.after! / 10_000 - 0.5)).toBeLessThan(0.02);
    // stable per user
    expect(evaluate(p, "f", { id: "u1" })).toEqual(evaluate(p, "f", { id: "u1" }));
  });

  test("experiment: missing hash attribute or failed conditions → skip", () => {
    const p = feature({ defaultValue: "d", rules: [experiment({ conditions: cond("country", "eq", "jp") })] });
    expect(evaluate(p, "f", { country: "jp" }).source).toBe("default");
    expect(evaluate(p, "f", { id: "u1", country: "us" }).source).toBe("default");
    expect(evaluate(p, "f", { id: "u1", country: "jp" }).source).toBe("experiment");
  });
});
