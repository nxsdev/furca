import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { ExperimentAnalysisService } from "@kuji/core/analysis/Analysis";
import { CredentialCipher } from "@kuji/core/datasources/CredentialCipher";
import { defaultStatsSettings, Experiment, ExperimentPhase, ExperimentPlan, StatsSettings, Variation } from "@kuji/core/experiments/Experiment";
import {
  EventMetricDefinition,
  EventSource,
  Metric,
  MetricCapping,
  MetricDefinition,
  SqlMetricDefinition,
} from "@kuji/core/metrics/Metric";
import { makeDrizzle } from "@kuji/database/Database";
import { dataSources, experiments, features, metrics } from "@kuji/database/schema/index";
import { makeTestD1, TestDatabaseLayer } from "@kuji/database/testing/TestDatabase";
import { bqResult, fakeBigQuery, makeTestServiceAccount } from "@kuji/integrations/bigquery/testing";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { bigQueryMomentsSql, d1ExposureCountsSql, d1MomentsSql, LOOKBACK_MS } from "../src/Layers/AnalysisSql";
import { ExperimentAnalysisServiceLive } from "../src/Layers/ExperimentAnalysisServiceLive";
import { experimentJsonColumns } from "../src/mappers";

const t = await makeTestD1();
afterAll(() => t.dispose());
const db = makeDrizzle(t.d1);

const H = 3_600_000;
const D = 24 * H;
const START = Date.UTC(2026, 9, 1);
const END = START + 10 * D;
const PROD = "env_production";

const exec = (sql: string, ...params: Array<string | number | null>) => t.d1.prepare(sql).bind(...params).run();
const exposure = (user: string, variation: string, at: number, env = PROD, key = "exp", phase = 0) =>
  exec(
    "INSERT INTO exposures (environment_id, experiment_key, variation_key, user_id, first_seen_at, phase) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    env,
    key,
    variation,
    user,
    at,
    phase,
  );
const event = (user: string, name: string, value: number | null, ts: number, env = PROD) =>
  exec("INSERT INTO events (environment_id, user_id, name, value, ts) VALUES (?1, ?2, ?3, ?4, ?5)", env, user, name, value, ts);

const purchase = (aggregation: "count" | "sum") => EventSource.make({ event: "purchase", aggregation });
const metric = (fields: Partial<Metric> = {}) =>
  Metric.make({
    id: "m",
    key: "m",
    name: "Metric",
    description: "",
    type: "mean",
    dataSourceId: "builtin",
    definition: EventMetricDefinition.make({ numerator: purchase("sum"), denominator: null }),
    inverse: false,
    windowHours: null,
    delayHours: 0,
    capping: { type: "none" },
    archived: false,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    ...fields,
  });

describe("D1 moments SQL", () => {
  // control: u1 (t0 = +1h), u2 (+2h) on 10-01; treatment: u4 (+3h) on 10-01, u3 (+25h) on 10-02
  const t1 = START + H;
  const t3 = START + 25 * H;
  const seeded = Promise.all([
    exposure("u1", "control", t1),
    exposure("u2", "control", START + 2 * H),
    exposure("u3", "treatment", t3),
    exposure("u4", "treatment", START + 3 * H),
    exposure("u5", "control", START + 4 * H), // multiple exposure
    exposure("u5", "treatment", START + 5 * H),
    exposure("u6", "treatment", START - H), // before the phase
    exposure("u7", "treatment", END + H), // after the window
    exposure("u8", "control", START + H, "env_development"),
    event("u1", "purchase", 10, t1 + H / 2),
    event("u1", "purchase", 5, t1 + 30 * H),
    event("u1", "purchase", 7, t1 - 2 * H), // before exposure: CUPED pre-period only
    event("u1", "purchase", 3, t1 - 20 * D), // older than the 14-day lookback
    event("u1", "visit", null, t1),
    event("u1", "visit", null, t1 + H),
    event("u2", "visit", null, START + 3 * H),
    event("u3", "purchase", 100, t3 + H),
    event("u3", "purchase", 4, t3 - 3 * D), // pre-period
    event("u3", "purchase", 999, END + H), // after the analysis window
    event("u3", "visit", null, t3 + H),
    event("u4", "purchase", 20, START + 3 * H + 80 * H), // outside a 72h conversion window
    event("u4", "visit", null, START + 4 * H),
    event("u4", "visit", null, START + 5 * H),
    event("u4", "visit", null, START + 6 * H),
    event("u5", "purchase", 50, START + 6 * H),
    event("u1", "purchase", 1000, t1 + H, "env_development"),
  ]);

  const window = { environmentId: PROD, phase: 0, experimentKey: "exp", startMs: START, endMs: END };
  const moments = async (m: Metric, cuped = false) => {
    await seeded;
    const d = m.definition as EventMetricDefinition;
    const q = d1MomentsSql({ ...window, metric: m, cuped, numerator: d.numerator, denominator: d.denominator });
    const { results } = await t.d1.prepare(q.sql).bind(...q.params).all<Record<string, number | string | null>>();
    return Object.fromEntries(results.map(({ variation, day, ...rest }) => [`${variation} ${day}`, rest]));
  };
  const zeros = { sum_d: 0, sum_d2: 0, sum_yd: 0, sum_x: 0, sum_x2: 0, sum_xy: 0, cap_value: null };

  it("counts users per variation in the window and multiple exposures separately", async () => {
    await seeded;
    const q = d1ExposureCountsSql(window);
    const { results } = await t.d1.prepare(q.sql).bind(...q.params).all();
    expect(results).toEqual(
      expect.arrayContaining([
        { variation: "control", users: 2 },
        { variation: "treatment", users: 2 },
        { variation: null, users: 1 },
      ]),
    );
    expect(results).toHaveLength(3);
  });

  it("proportion: 1 per unit with any event after exposure, 0 otherwise, by first-exposure day", async () => {
    expect(await moments(metric({ type: "proportion", definition: EventMetricDefinition.make({ numerator: purchase("count"), denominator: null }) }))).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 1, sum_y2: 1, ...zeros },
      "treatment 2026-10-01": { n: 1, sum_y: 1, sum_y2: 1, ...zeros },
      "treatment 2026-10-02": { n: 1, sum_y: 1, sum_y2: 1, ...zeros },
    });
  });

  it("mean sum within a 72h window ignores events before exposure, after the window and other environments", async () => {
    expect(await moments(metric({ windowHours: 72 }))).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 15, sum_y2: 225, ...zeros },
      "treatment 2026-10-01": { n: 1, sum_y: 0, sum_y2: 0, ...zeros },
      "treatment 2026-10-02": { n: 1, sum_y: 100, sum_y2: 10000, ...zeros },
    });
  });

  it("mean count with a 1h delay skips events in the first hour (the boundary is inclusive)", async () => {
    expect(await moments(metric({ delayHours: 1, definition: EventMetricDefinition.make({ numerator: purchase("count"), denominator: null }) }))).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 1, sum_y2: 1, ...zeros },
      "treatment 2026-10-01": { n: 1, sum_y: 1, sum_y2: 1, ...zeros },
      "treatment 2026-10-02": { n: 1, sum_y: 1, sum_y2: 1, ...zeros },
    });
  });

  it("ratio: per-unit numerator and denominator sums with cross products", async () => {
    const definition = EventMetricDefinition.make({ numerator: purchase("sum"), denominator: EventSource.make({ event: "visit", aggregation: "count" }) });
    expect(await moments(metric({ type: "ratio", definition }), true)).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 15, sum_y2: 225, sum_d: 3, sum_d2: 5, sum_yd: 30, sum_x: 0, sum_x2: 0, sum_xy: 0, cap_value: null },
      "treatment 2026-10-01": { n: 1, sum_y: 20, sum_y2: 400, sum_d: 3, sum_d2: 9, sum_yd: 60, sum_x: 0, sum_x2: 0, sum_xy: 0, cap_value: null },
      "treatment 2026-10-02": { n: 1, sum_y: 100, sum_y2: 10000, sum_d: 1, sum_d2: 1, sum_yd: 100, sum_x: 0, sum_x2: 0, sum_xy: 0, cap_value: null },
    });
  });

  it("absolute capping applies min(value, cap) to per-unit totals and reports the cap", async () => {
    expect(await moments(metric({ capping: { type: "absolute", value: 12 } }))).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 12, sum_y2: 144, ...zeros, cap_value: 12 },
      "treatment 2026-10-01": { n: 1, sum_y: 12, sum_y2: 144, ...zeros, cap_value: 12 },
      "treatment 2026-10-02": { n: 1, sum_y: 12, sum_y2: 144, ...zeros, cap_value: 12 },
    });
  });

  it("percentile capping uses the nearest-rank quantile of per-unit values pooled across variations", async () => {
    // per-unit sums [0, 15, 20, 100]; p = 0.5 -> offset floor(0.5 * 3) = 1 -> cap 15
    expect(await moments(metric({ capping: { type: "percentile", value: 0.5 } }))).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 15, sum_y2: 225, ...zeros, cap_value: 15 },
      "treatment 2026-10-01": { n: 1, sum_y: 15, sum_y2: 225, ...zeros, cap_value: 15 },
      "treatment 2026-10-02": { n: 1, sum_y: 15, sum_y2: 225, ...zeros, cap_value: 15 },
    });
  });

  it("CUPED covariate sums the same metric over the 14 days before first exposure", async () => {
    expect(await moments(metric(), true)).toEqual({
      "control 2026-10-01": { n: 2, sum_y: 15, sum_y2: 225, ...zeros, sum_x: 7, sum_x2: 49, sum_xy: 105 },
      "treatment 2026-10-01": { n: 1, sum_y: 20, sum_y2: 400, ...zeros },
      "treatment 2026-10-02": { n: 1, sum_y: 100, sum_y2: 10000, ...zeros, sum_x: 4, sum_x2: 16, sum_xy: 400 },
    });
    const proportion = await moments(metric({ type: "proportion" }), true);
    expect(proportion["control 2026-10-01"]).toMatchObject({ sum_x: 1, sum_x2: 1, sum_xy: 1 });
  });
});

describe("BigQuery moments SQL", () => {
  it("wraps the data source and metric SQL as CTEs and passes every value as a named parameter", () => {
    const q = bigQueryMomentsSql({
      experimentKey: "checkout'; DROP TABLE x; --",
      startMs: START,
      endMs: END,
      cuped: true,
      metric: metric({ type: "ratio", windowHours: 72, delayHours: 1, capping: { type: "percentile", value: 0.99 } }),
      exposureSql: "SELECT * FROM `acme.analytics.exposures`;  ",
      numeratorSql: "SELECT user_id, timestamp, revenue AS value FROM orders",
      denominatorSql: "SELECT user_id, timestamp, 1 AS value FROM sessions",
    });
    expect(q.params).toEqual({
      experiment_key: "checkout'; DROP TABLE x; --",
      start_ms: START,
      end_ms: END,
      delay_ms: H,
      window_ms: 72 * H,
      cap_percentile: 0.99,
    });
    expect(q.sql).not.toContain("DROP TABLE");
    expect(q.sql).toContain("kuji_exposure_source AS (\nSELECT * FROM `acme.analytics.exposures`\n)");
    expect(q.sql).toContain("kuji_denominator_source AS (\nSELECT user_id, timestamp, 1 AS value FROM sessions\n)");
    expect(q.sql).toContain("APPROX_QUANTILES(y, 1000)");
    expect(q.sql).not.toContain("kuji_pre"); // no CUPED for ratio metrics
  });

  it("omits the window bound without a window, adds the lookback for CUPED and never caps proportions", () => {
    const q = bigQueryMomentsSql({
      experimentKey: "checkout",
      startMs: START,
      endMs: END,
      cuped: true,
      metric: metric({ type: "proportion", capping: { type: "absolute", value: 1 } }),
      exposureSql: "SELECT 1",
      numeratorSql: "SELECT 1",
      denominatorSql: null,
    });
    expect(q.params).toEqual({ experiment_key: "checkout", start_ms: START, end_ms: END, delay_ms: 0, lookback_ms: LOOKBACK_MS });
    expect(q.sql).not.toContain("@window_ms");
    expect(q.sql).not.toContain("LEAST(");
    expect(q.sql).toContain("IF(pr.user_id IS NULL, 0, 1) AS x");
  });
});

// ---------------------------------------------------------------------------------------------
// refresh / latest end to end

const layer = ExperimentAnalysisServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestDatabaseLayer(t.d1),
      Layer.succeed(CredentialCipher, { encrypt: Effect.succeed, decrypt: Effect.succeed }),
    ),
  ),
);
const run = <A, E>(effect: Effect.Effect<A, E, ExperimentAnalysisService>) => Effect.runPromise(Effect.provide(effect, layer));
const refresh = (id: string) => run(ExperimentAnalysisService.use((s) => s.refresh(id)));

await db.insert(features).values({ id: "f1", key: "flag", valueType: "boolean", defaultValue: "false", tags: [] });
const insertMetric = (id: string, type: Metric["type"], definition: MetricDefinition, dataSourceId = "builtin", capping: MetricCapping = { type: "none" }) =>
  db.insert(metrics).values({ id, key: id, name: id, type, dataSourceId, definition: Schema.encodeSync(MetricDefinition)(definition), capping });
await insertMetric("purchase", "proportion", EventMetricDefinition.make({ numerator: purchase("count"), denominator: null }));
await insertMetric("purchase_again", "proportion", EventMetricDefinition.make({ numerator: purchase("count"), denominator: null }));

const insertExperiment = (id: string, fields: Partial<Experiment> = {}) => {
  const e = Experiment.make({
    id,
    key: id,
    name: id,
    hypothesis: "",
    status: "running",
    featureId: "f1",
    environmentIds: [PROD],
    analysisEnvironmentId: PROD,
    hashAttribute: "id",
    variations: [Variation.make({ key: "control", name: "Control", value: "false" }), Variation.make({ key: "treatment", name: "Treatment", value: "true" })],
    phases: [ExperimentPhase.make({ startedAt: new Date(START), endedAt: null, coverage: 1, weights: [0.5, 0.5], conditions: [], seed: "s", reason: "" })],
    coverage: 1,
    weights: [0.5, 0.5],
    conditions: [],
    dataSourceId: "builtin",
    primaryMetricId: "purchase",
    secondaryMetricIds: [],
    guardrailMetricIds: [],
    stats: defaultStatsSettings(),
    plan: ExperimentPlan.make({ mde: 0.1, sampleSizePerVariation: null, dailyTraffic: null }),
    decision: null,
    archived: false,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    startedAt: new Date(START),
    stoppedAt: null,
    ...fields,
  });
  return db.insert(experiments).values({ ...e, archivedAt: null, ...experimentJsonColumns(e) });
};

/** `users` units of one variation spread over 4 days; the first `converted` purchase 1h after exposure */
const seedArm = (key: string, variation: string, users: number, converted: number) =>
  t.d1.batch([
    t.d1
      .prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ?1 - 1)
         INSERT INTO exposures (environment_id, experiment_key, variation_key, user_id, first_seen_at)
         SELECT ?2, ?3, ?4, ?3 || ?4 || i, ?5 + (i % 4) * ${D} + i FROM seq`,
      )
      .bind(users, PROD, key, variation, START),
    t.d1
      .prepare(
        `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ?1 - 1)
         INSERT INTO events (environment_id, user_id, name, value, ts) SELECT ?2, ?3 || ?4 || i, 'purchase', NULL, ?5 + (i % 4) * ${D} + i + ${H} FROM seq`,
      )
      .bind(converted, PROD, key, variation, START),
  ]);

describe("ExperimentAnalysisService.refresh", () => {
  it("flags a real effect (10% vs 14% of 2,000 users per arm) as winning with healthy traffic", async () => {
    await insertExperiment("checkout");
    await seedArm("checkout", "control", 2000, 200);
    await seedArm("checkout", "treatment", 2000, 280);

    const snapshot = await refresh("checkout");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.health).toMatchObject({ totalUsers: 4000, multipleExposureUsers: 0, multipleExposuresOk: true, srm: { observed: [2000, 2000], ok: true } });
    const [primary] = snapshot.metrics;
    expect(primary).toMatchObject({ metricId: "purchase", role: "primary", error: null, capValue: null });
    expect(primary!.variations.map((v) => [v.users, v.mean])).toEqual([
      [2000, 0.1],
      [2000, 0.14],
    ]);
    const [comparison] = primary!.comparisons;
    expect(comparison!.verdict).toBe("winning");
    expect(comparison!.lift).toBeCloseTo(0.4, 10);
    expect(comparison!.ci![0]).toBeGreaterThan(0);
    expect(primary!.timeseries.map((p) => [p.date, p.users])).toEqual([
      ["2026-10-01", 1000],
      ["2026-10-02", 2000],
      ["2026-10-03", 3000],
      ["2026-10-04", 4000],
    ]);
    expect(primary!.timeseries.at(-1)!.comparisons[0]!.lift).toBeCloseTo(0.4, 10);

    const latest = await run(ExperimentAnalysisService.use((s) => s.latest("checkout")));
    expect(latest).toEqual(snapshot);
  });

  it("Holm-corrects primary and secondary metrics as separate families, so secondaries never cost the primary power", async () => {
    const stats = (correction: "none" | "holm") => ({ ...StatsSettings.make({ ...defaultStatsSettings(), sequential: false, correction }) });
    // Two secondary comparisons form their own family; the primary is alone in its family
    await db.update(experiments).set({ secondaryMetricIds: ["purchase_again", "purchase_again"], stats: stats("none") }).where(eq(experiments.id, "checkout"));
    const raw = (await refresh("checkout")).metrics.map((m) => m.comparisons[0]!);
    await db.update(experiments).set({ stats: stats("holm") }).where(eq(experiments.id, "checkout"));
    const adjusted = (await refresh("checkout")).metrics.map((m) => m.comparisons[0]!);

    expect(adjusted[0]!.pValue).toBeCloseTo(raw[0]!.pValue!, 12);
    expect(adjusted[0]!.ci).toEqual(raw[0]!.ci);
    expect(adjusted[1]!.pValue).toBeCloseTo(Math.min(1, 2 * raw[1]!.pValue!), 12);
    expect(adjusted[2]!.pValue).toBeCloseTo(Math.min(1, 2 * raw[2]!.pValue!), 12);
    expect(adjusted[1]!.ci![0]).toBeLessThan(raw[1]!.ci![0]);
    expect(adjusted[1]!.ci![1]).toBeGreaterThan(raw[1]!.ci![1]);
    await db.update(experiments).set({ secondaryMetricIds: ["purchase_again"] }).where(eq(experiments.id, "checkout"));
  });

  it("fails the SRM check when a 50/50 split delivers 1,000 vs 1,200 users", async () => {
    await insertExperiment("unbalanced");
    await seedArm("unbalanced", "control", 1000, 100);
    await seedArm("unbalanced", "treatment", 1200, 120);
    const { health } = await refresh("unbalanced");
    expect(health!.srm.observed).toEqual([1000, 1200]);
    expect(health!.srm.pValue).toBeLessThan(0.001);
    expect(health!.srm.ok).toBe(false);
  });

  it("stores an error snapshot instead of failing when the data source no longer exists", async () => {
    await insertExperiment("orphan", { dataSourceId: "deleted-source" });
    const snapshot = await refresh("orphan");
    expect(snapshot).toMatchObject({ status: "error", health: null, metrics: [] });
    expect(snapshot.error).toBe("The experiment's data source deleted-source no longer exists");
  });

  it("reports a missing metric on that metric and still analyzes the others", async () => {
    await db.update(experiments).set({ secondaryMetricIds: ["gone"] }).where(eq(experiments.id, "unbalanced"));
    const { status, metrics: results } = await refresh("unbalanced");
    expect(status).toBe("ok");
    expect(results.map((m) => [m.role, m.error])).toEqual([
      ["primary", null],
      ["secondary", "Metric gone no longer exists"],
    ]);
  });

  describe("phases", () => {
    const PHASE_1 = START + 2 * D;
    const twoPhases = [
      ExperimentPhase.make({ startedAt: new Date(START), endedAt: new Date(PHASE_1), coverage: 1, weights: [0.5, 0.5], conditions: [], seed: "s0", reason: "" }),
      ExperimentPhase.make({ startedAt: new Date(PHASE_1), endedAt: null, coverage: 1, weights: [0.5, 0.5], conditions: [], seed: "s1", reason: "weights" }),
    ];

    it("counts re-randomized phase-1 users who land in the same variation as in phase 0", async () => {
      await insertExperiment("rerand", { phases: twoPhases });
      await exposure("same", "control", START + H, PROD, "rerand", 0);
      await exposure("same", "control", PHASE_1 + H, PROD, "rerand", 1);
      await exposure("switched", "control", START + H, PROD, "rerand", 0);
      await exposure("switched", "treatment", PHASE_1 + H, PROD, "rerand", 1);
      await exposure("new", "treatment", PHASE_1 + 2 * H, PROD, "rerand", 1);
      const { phaseIndex, health } = await refresh("rerand");
      expect(phaseIndex).toBe(1);
      expect(health).toMatchObject({ srm: { observed: [1, 2] }, multipleExposureUsers: 0 });
    });

    it("ignores stale phase-0 exposures that arrive after phase 1 started", async () => {
      await insertExperiment("stale", { phases: twoPhases });
      await exposure("current", "control", PHASE_1 + H, PROD, "stale", 1);
      await exposure("cached-payload", "treatment", PHASE_1 + 3 * H, PROD, "stale", 0);
      await exposure("cached-payload", "control", PHASE_1 + 4 * H, PROD, "stale", 1);
      const { health } = await refresh("stale");
      expect(health).toMatchObject({ srm: { observed: [2, 0] }, multipleExposureUsers: 0 });
    });
  });

  it("rejects drafts and returns null as the latest snapshot of a draft", async () => {
    await insertExperiment("draft", { status: "draft", phases: [] });
    const error = await run(Effect.flip(ExperimentAnalysisService.use((s) => s.refresh("draft"))));
    expect(error).toMatchObject({ _tag: "ValidationError", message: "Start the experiment to see results" });
    expect(await run(ExperimentAnalysisService.use((s) => s.latest("draft")))).toBeNull();
  });
});

describe("ExperimentAnalysisService.refresh with BigQuery", () => {
  let fake: ReturnType<typeof fakeBigQuery> | undefined;
  afterEach(() => fake?.restore());

  it("runs the exposure and metric queries with parameters and analyzes the returned moments", async () => {
    const sa = await makeTestServiceAccount();
    await db.insert(dataSources).values({
      id: "bq",
      name: "Warehouse",
      type: "bigquery",
      config: { projectId: "acme", dataset: "analytics", location: "US" },
      credentials: JSON.stringify(sa),
      exposureSql: "SELECT * FROM exposures",
    });
    await insertMetric("bq_orders", "proportion", SqlMetricDefinition.make({ numeratorSql: "SELECT user_id, timestamp, 1 AS value FROM orders", denominatorSql: null }), "bq");
    await insertExperiment("bq_exp", { dataSourceId: "bq", primaryMetricId: "bq_orders" });
    const columns = { variation: "STRING", day: "STRING", n: "INTEGER", sum_y: "INTEGER", sum_y2: "INTEGER", sum_d: "INTEGER", sum_d2: "INTEGER", sum_yd: "INTEGER", sum_x: "INTEGER", sum_x2: "INTEGER", sum_xy: "INTEGER", cap_value: "FLOAT" };
    fake = fakeBigQuery([
      { body: bqResult({ variation: "STRING", users: "INTEGER" }, [["control", 500], ["treatment", 500], [null, 3]]) },
      {
        body: bqResult(columns, [
          ["control", "2026-10-01", 500, 50, 50, 0, 0, 0, 0, 0, 0, null],
          ["treatment", "2026-10-01", 500, 75, 75, 0, 0, 0, 0, 0, 0, null],
        ]),
      },
    ]);

    const snapshot = await refresh("bq_exp");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.health).toMatchObject({ totalUsers: 1000, multipleExposureUsers: 3, multipleExposuresOk: true });
    expect(snapshot.metrics[0]!.variations.map((v) => v.mean)).toEqual([0.1, 0.15]);
    const [counts, moments] = fake.requests as Array<{ body: { query: string; queryParameters: Array<{ name: string; parameterValue: { value: string } }> } }>;
    expect(counts!.body.query).toContain("kuji_exposure_source AS (\nSELECT * FROM exposures\n)");
    expect(moments!.body.query).toContain("kuji_numerator_source AS (\nSELECT user_id, timestamp, 1 AS value FROM orders\n)");
    expect(moments!.body.queryParameters.find((p) => p.name === "experiment_key")!.parameterValue.value).toBe("bq_exp");
  });

  it("stores the warehouse error message when BigQuery rejects the query", async () => {
    fake = fakeBigQuery([{ status: 404, body: { error: { message: "Not found: Table acme:analytics.exposures was not found in location US" } } }]);
    const snapshot = await refresh("bq_exp");
    expect(snapshot).toMatchObject({ status: "error", error: "BigQuery: Not found: Table acme:analytics.exposures was not found in location US" });
  });
});
