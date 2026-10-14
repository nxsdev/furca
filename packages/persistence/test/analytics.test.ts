import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { EventStatsService, ExperimentAnalysisService } from "@furca/core/analysis/Analysis";
import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { defaultStatsSettings, Experiment, ExperimentPhase, ExperimentPlan, StatsSettings, Variation } from "@furca/core/experiments/Experiment";
import {
  EventMetricDefinition,
  EventSource,
  Metric,
  MetricDefinition,
  PropertyFilter,
  type PropertyFilterOperator,
  SqlMetricDefinition,
} from "@furca/core/metrics/Metric";
import { makeDrizzle } from "@furca/database/Database";
import { dataSources, experiments, features, metrics } from "@furca/database/schema/index";
import { makeTestD1, TestDatabaseLayer } from "@furca/database/testing/TestDatabase";
import { bqResult, fakeBigQuery, makeTestServiceAccount } from "@furca/integrations/bigquery/testing";
import { Effect, Layer, Schema } from "effect";
import { bigQueryExposureCountsSql, bigQueryMomentsSql, d1MomentsSql } from "../src/Layers/AnalysisSql";
import { EventStatsServiceLive } from "../src/Layers/EventStatsServiceLive";
import { ExperimentAnalysisServiceLive } from "../src/Layers/ExperimentAnalysisServiceLive";
import { filtersProblem } from "../src/Layers/MetricServiceLive";
import { experimentJsonColumns } from "../src/mappers";

const t = await makeTestD1();
afterAll(() => t.dispose());
const db = makeDrizzle(t.d1);

const layer = Layer.mergeAll(ExperimentAnalysisServiceLive, EventStatsServiceLive).pipe(
  Layer.provide(Layer.mergeAll(TestDatabaseLayer(t.d1), Layer.succeed(CredentialCipher, { encrypt: Effect.succeed, decrypt: Effect.succeed }))),
);
const run = <A, E>(effect: Effect.Effect<A, E, ExperimentAnalysisService | EventStatsService>) => Effect.runPromise(Effect.provide(effect, layer));

const H = 3_600_000;
const D = 24 * H;
const START = Date.UTC(2026, 9, 1);
const PROD = "env_production";

const insertExposure = (key: string, user: string, variation: string, at: number, dimensions: unknown = null) =>
  t.d1
    .prepare(
      "INSERT INTO exposures (environment_id, experiment_key, variation_key, user_id, first_seen_at, phase, dimensions) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
    )
    .bind(PROD, key, variation, user, at, dimensions === null ? null : JSON.stringify(dimensions));
const insertEvent = (user: string, name: string, ts: number, properties: unknown = null, env = PROD) =>
  t.d1
    .prepare("INSERT INTO events (environment_id, user_id, name, value, ts, properties) VALUES (?1, ?2, ?3, NULL, ?4, ?5)")
    .bind(env, user, name, ts, properties === null ? null : JSON.stringify(properties));

const countMetric = (event: string, filters: ReadonlyArray<PropertyFilter> = []) =>
  Metric.make({
    id: "m",
    key: "m",
    name: "Metric",
    description: "",
    type: "mean",
    dataSourceId: "builtin",
    definition: EventMetricDefinition.make({ numerator: EventSource.make({ event, aggregation: "count", filters }), denominator: null }),
    inverse: false,
    windowHours: null,
    delayHours: 0,
    capping: { type: "none" },
    archived: false,
    createdAt: new Date(START),
    updatedAt: new Date(START),
  });

describe("metric property filters (D1)", () => {
  // One exposed unit with one event per property shape; sum_y counts the events a filter keeps
  const seeded = t.d1.batch([
    insertExposure("filters", "u1", "control", START),
    insertEvent("u1", "purchase", START + H, { plan: "pro", seats: 5, trial: true, "utm.source": "google" }),
    insertEvent("u1", "purchase", START + H, { plan: "free", seats: 1 }),
    insertEvent("u1", "purchase", START + H, { plan: "enterprise", trial: false }),
    insertEvent("u1", "purchase", START + H, { seats: "12" }),
    insertEvent("u1", "purchase", START + H),
  ]);
  const matching = async (...filters: ReadonlyArray<[string, PropertyFilterOperator, ...string[]]>) => {
    await seeded;
    const metric = countMetric(
      "purchase",
      filters.map(([property, operator, ...values]) => PropertyFilter.make({ property, operator, values })),
    );
    const d = metric.definition as EventMetricDefinition;
    const q = d1MomentsSql({
      environmentId: PROD,
      phase: 0,
      experimentKey: "filters",
      startMs: START,
      endMs: START + D,
      metric,
      cuped: true,
      numerator: d.numerator,
      denominator: null,
    });
    const row = await t.d1.prepare(q.sql).bind(...q.params).first<{ sum_y: number; sum_x: number }>();
    return row!.sum_y;
  };

  it("eq / neq compare text, booleans as true / false, and neq matches events without the property", async () => {
    expect(await matching(["plan", "eq", "pro"])).toBe(1);
    expect(await matching(["plan", "neq", "pro"])).toBe(4);
    expect(await matching(["trial", "eq", "true"])).toBe(1);
    expect(await matching(["trial", "eq", "false"])).toBe(1);
    expect(await matching(["seats", "eq", "5"])).toBe(1);
  });

  it("in / not_in match any of the values; not_in also matches events without the property", async () => {
    expect(await matching(["plan", "in", "pro", "free"])).toBe(2);
    expect(await matching(["plan", "not_in", "pro", "free"])).toBe(3);
  });

  it("contains is a case-sensitive substring match and never matches a missing property", async () => {
    expect(await matching(["plan", "contains", "pr"])).toBe(2);
    expect(await matching(["plan", "contains", "PR"])).toBe(0);
  });

  it("gt / gte / lt / lte compare JSON numbers only (numeric strings and missing values never match)", async () => {
    expect(await matching(["seats", "gt", "1"])).toBe(1);
    expect(await matching(["seats", "gte", "1"])).toBe(2);
    expect(await matching(["seats", "lt", "5"])).toBe(1);
    expect(await matching(["seats", "lte", "5.0"])).toBe(2);
    expect(await matching(["plan", "gt", "-1"])).toBe(0);
  });

  it("exists / not_exists test presence; filters are AND-ed and dotted names are one key", async () => {
    expect(await matching(["trial", "exists"])).toBe(2);
    expect(await matching(["trial", "not_exists"])).toBe(3);
    expect(await matching(["plan", "in", "pro", "enterprise"], ["trial", "eq", "true"])).toBe(1);
    expect(await matching(["utm.source", "eq", "google"])).toBe(1);
  });

  it("binds property names and values instead of interpolating them", () => {
    const metric = countMetric("purchase", [PropertyFilter.make({ property: "x') OR 1=1 --", operator: "eq", values: ["' OR '1'='1"] })]);
    const d = metric.definition as EventMetricDefinition;
    const q = d1MomentsSql({ environmentId: PROD, phase: 0, experimentKey: "k", startMs: 0, endMs: 1, metric, cuped: false, numerator: d.numerator, denominator: null });
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.params).toContain(`$."x') OR 1=1 --"`);
    expect(q.params).toContain("' OR '1'='1");
  });

  it("rejects filters without a property, with the wrong number of values or a non-numeric bound", () => {
    const problem = (property: string, operator: PropertyFilterOperator, values: string[]) =>
      filtersProblem(EventSource.make({ event: "e", aggregation: "count", filters: [PropertyFilter.make({ property, operator, values })] }));
    expect(problem("plan", "eq", ["pro"])).toBeNull();
    expect(problem("plan", "in", ["pro", "free"])).toBeNull();
    expect(problem("plan", "exists", [])).toBeNull();
    expect(problem(" ", "eq", ["pro"])).toBe("Choose a property for every filter");
    expect(problem("plan", "eq", [])).toBe('Filter on "plan" needs exactly one value');
    expect(problem("plan", "eq", [""])).toBe('Filter on "plan" needs a value');
    expect(problem("plan", "in", [])).toBe('Filter on "plan" needs at least one value');
    expect(problem("plan", "exists", ["x"])).toBe('Filter on "plan" takes no value');
    expect(problem("seats", "gt", ["many"])).toBe('Filter on "seats" compares numbers: enter a number');
    expect(problem('a"b', "eq", ["x"])).toContain("not supported");
  });
});

describe("EventStatsService.properties", () => {
  const now = Date.now();
  const seeded = t.d1.batch([
    insertEvent("a", "checkout", now - H, { plan: "pro", coupon: true }),
    insertEvent("b", "checkout", now - H, { plan: "pro" }),
    insertEvent("c", "checkout", now - 2 * H, { plan: "free", seats: 3 }),
    insertEvent("d", "checkout", now - H),
    insertEvent("e", "checkout", now - 40 * D, { old: "x" }), // older than 30 days
    insertEvent("f", "checkout", now - H, { staging: "x" }, "env_development"),
    insertEvent("g", "signup", now - H, { referrer: "x" }),
  ]);

  it("lists keys seen on the event in the environment over 30 days with counts and top values", async () => {
    await seeded;
    expect(await run(EventStatsService.use((s) => s.properties(PROD, "checkout")))).toEqual([
      { property: "plan", count: 3, sampleValues: ["pro", "free"] },
      { property: "coupon", count: 1, sampleValues: ["true"] },
      { property: "seats", count: 1, sampleValues: ["3"] },
    ]);
    expect(await run(EventStatsService.use((s) => s.properties(PROD, "unknown")))).toEqual([]);
  });

  it("keeps the 10 most frequent values per property", async () => {
    await t.d1.batch(Array.from({ length: 12 }, (_, i) => Array.from({ length: i + 1 }, () => insertEvent("x", "view", now - H, { page: `p${i}` }))).flat());
    const [page] = await run(EventStatsService.use((s) => s.properties(PROD, "view")));
    expect(page).toEqual({ property: "page", count: 78, sampleValues: ["p11", "p10", "p9", "p8", "p7", "p6", "p5", "p4", "p3", "p2"] });
  });
});

await db.insert(features).values({ id: "f1", key: "flag", valueType: "boolean", defaultValue: "false", tags: [] });
await db.insert(metrics).values({
  id: "purchase",
  key: "purchase",
  name: "purchase",
  type: "proportion",
  dataSourceId: "builtin",
  definition: Schema.encodeSync(MetricDefinition)(countMetric("checkout_done").definition),
  capping: { type: "none" },
});

describe("ExperimentAnalysisService.dimension", () => {
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
      // The same metric twice: Holm would double their p-values in a snapshot, never in a breakdown
      secondaryMetricIds: ["purchase", "purchase"],
      guardrailMetricIds: [],
      stats: StatsSettings.make({ ...defaultStatsSettings(), sequential: false, correction: "holm" }),
      plan: ExperimentPlan.make({ mde: 0.1, sampleSizePerVariation: null, dailyTraffic: null }),
      dimensions: ["country"],
      namespace: null,
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
  const dimension = (id: string, name: string) => run(ExperimentAnalysisService.use((s) => s.dimension(id, name)));

  it("splits units into the top 20 values, (other) and (not set), analyzing each slice without correction", async () => {
    await insertExperiment("geo");
    // c00..c21: c00 has 400 units per arm, the others 22 - i; c20 and c21 fall into (other)
    const statements = [];
    for (let i = 0; i < 22; i++) {
      const country = `c${String(i).padStart(2, "0")}`;
      const perArm = i === 0 ? 400 : 22 - i;
      for (const variation of ["control", "treatment"]) {
        for (let u = 0; u < perArm; u++) {
          const user = `${country}-${variation}-${u}`;
          statements.push(insertExposure("geo", user, variation, START + H, { country, plan: "pro" }));
          const converts = i === 0 && u < (variation === "control" ? 40 : 80);
          if (converts) statements.push(insertEvent(user, "checkout_done", START + 2 * H));
        }
      }
    }
    statements.push(
      insertExposure("geo", "no-dims", "control", START + H),
      insertExposure("geo", "other-dims", "treatment", START + H, { plan: "free" }),
      insertExposure("geo", "both", "control", START + H, { country: "c00" }), // multiple exposure: excluded
      insertExposure("geo", "both", "treatment", START + 2 * H, { country: "c00" }),
    );
    for (let i = 0; i < statements.length; i += 500) await t.d1.batch(statements.slice(i, i + 500));

    const result = await dimension("geo", "country");
    expect(result.error).toBeNull();
    expect(result.slices.map((s) => [s.value, s.users])).toEqual([
      ["c00", 800],
      ...Array.from({ length: 19 }, (_, k) => [`c${String(k + 1).padStart(2, "0")}`, 2 * (21 - k)]),
      ["(other)", 2 * 2 + 2 * 1],
      ["(not set)", 2],
    ]);
    const [top] = result.slices;
    expect(top!.metrics.map((m) => m.role)).toEqual(["primary", "secondary", "secondary"]);
    expect(top!.metrics[0]!.variations.map((v) => [v.users, v.mean])).toEqual([
      [400, 0.1],
      [400, 0.2],
    ]);
    const [primary, secondary] = top!.metrics.map((m) => m.comparisons[0]!);
    expect(primary!.verdict).toBe("winning");
    expect(secondary!.pValue).toBe(primary!.pValue);
    expect(result.slices.at(-1)!.metrics[0]!.variations.map((v) => v.users)).toEqual([1, 1]);
  });

  it("rejects dimensions the experiment does not record and reports a missing data source in the result", async () => {
    const error = await run(Effect.flip(ExperimentAnalysisService.use((s) => s.dimension("geo", "plan"))));
    expect(error).toMatchObject({ _tag: "ValidationError" });
    await insertExperiment("orphan_geo", { dataSourceId: "gone" });
    expect(await dimension("orphan_geo", "country")).toMatchObject({ slices: [], error: "The experiment's data source gone no longer exists" });
  });

  describe("BigQuery", () => {
    let fake: ReturnType<typeof fakeBigQuery> | undefined;
    afterEach(() => fake?.restore());

    it("reads the dimension from an exposure SQL column with the same name and slices every output", () => {
      const window = { experimentKey: "exp", startMs: START, endMs: START + D, dimension: "country", exposureSql: "SELECT * FROM exposures" };
      const counts = bigQueryExposureCountsSql(window);
      expect(counts.sql).toContain("ARRAY_AGG(CAST(`country` AS STRING) IGNORE NULLS ORDER BY timestamp LIMIT 1)[SAFE_OFFSET(0)] AS dim");
      expect(counts.sql).toMatch(/LIMIT 20\)\s+THEN dim ELSE '\(other\)' END AS slice/);
      expect(counts.sql).toMatch(/SELECT slice, IF\(nv > 1, NULL, variation\) AS variation, COUNT\(\*\) AS users\s+FROM furca_units GROUP BY 1, 2$/);
      const moments = bigQueryMomentsSql({ ...window, cuped: false, metric: countMetric("x"), numeratorSql: "SELECT 1", denominatorSql: null });
      expect(moments.sql).toContain("SELECT slice, u.variation, u.t0");
      expect(moments.sql).toContain("GROUP BY slice, variation, day");
      expect(() => bigQueryExposureCountsSql({ ...window, dimension: "x` UNION ALL SELECT" })).toThrow();
    });

    it("explains how to add the column when the exposure SQL has none, or the name cannot be a column", async () => {
      const sa = await makeTestServiceAccount();
      await db.insert(dataSources).values({
        id: "bq",
        name: "Warehouse",
        type: "bigquery",
        config: { projectId: "acme", dataset: "analytics", location: "US" },
        credentials: JSON.stringify(sa),
        exposureSql: "SELECT * FROM exposures",
      });
      await db.insert(metrics).values({
        id: "bq_orders",
        key: "bq_orders",
        name: "bq_orders",
        type: "proportion",
        dataSourceId: "bq",
        definition: Schema.encodeSync(MetricDefinition)(SqlMetricDefinition.make({ numeratorSql: "SELECT 1", denominatorSql: null })),
        capping: { type: "none" },
      });
      await insertExperiment("bq_geo", { dataSourceId: "bq", primaryMetricId: "bq_orders", secondaryMetricIds: [], dimensions: ["country", "app.version"] });
      fake = fakeBigQuery([{ status: 400, body: { error: { message: "Unrecognized name: country at [6:20]" } } }]);
      const missing = "Add a column named country to the exposure SQL to break results down by it";
      expect(await dimension("bq_geo", "country")).toMatchObject({ slices: [], error: missing });
      expect((await dimension("bq_geo", "app.version")).error).toBe(
        "Add a column named app.version to the exposure SQL to break results down by it",
      );
      expect(fake.requests).toHaveLength(1);

      fake.restore();
      fake = fakeBigQuery([
        { body: bqResult({ slice: "STRING", variation: "STRING", users: "INTEGER" }, [["jp", "control", 10], ["jp", "treatment", 12], ["(not set)", "control", 1]]) },
        {
          body: bqResult({ slice: "STRING", variation: "STRING", day: "STRING", n: "INTEGER", sum_y: "INTEGER", sum_y2: "INTEGER", cap_value: "FLOAT" }, [
            ["jp", "control", "2026-10-01", 10, 1, 1, null],
            ["jp", "treatment", "2026-10-01", 12, 3, 3, null],
            ["(not set)", "control", "2026-10-01", 1, 0, 0, null],
          ]),
        },
      ]);
      const ok = await dimension("bq_geo", "country");
      expect(ok.slices.map((s) => [s.value, s.users, s.metrics[0]!.variations.map((v) => v.users)])).toEqual([
        ["jp", 22, [10, 12]],
        ["(not set)", 1, [1, 0]],
      ]);
    });
  });
});
