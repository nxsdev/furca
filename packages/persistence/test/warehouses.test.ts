import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { ExperimentAnalysisService } from "@furca/core/analysis/Analysis";
import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import {
  BigQueryConfig,
  ClickHouseConfig,
  PostgresConfig,
  SnowflakeConfig,
  WarehouseConfig,
  type WarehouseType,
} from "@furca/core/datasources/DataSource";
import { DataSourceService } from "@furca/core/datasources/DataSourceService";
import { defaultStatsSettings, Experiment, ExperimentPhase, ExperimentPlan, Variation } from "@furca/core/experiments/Experiment";
import { Metric, MetricDefinition, SqlMetricDefinition } from "@furca/core/metrics/Metric";
import { makeDrizzle } from "@furca/database/Database";
import { dataSources, experiments, features, metrics } from "@furca/database/schema/index";
import { makeTestD1, TestDatabaseLayer } from "@furca/database/testing/TestDatabase";
import { bqResult, fakeBigQuery, makeTestServiceAccount } from "@furca/integrations/bigquery/testing";
import * as Postgres from "@furca/integrations/postgres/client";
import { Effect, Layer, Schema } from "effect";
import { warehouseExposureCountsSql, warehouseMomentsSql } from "../src/Layers/AnalysisSql";
import { checkConfig, checkCredentials, DataSourceServiceLive } from "../src/Layers/DataSourceServiceLive";
import { ExperimentAnalysisServiceLive } from "../src/Layers/ExperimentAnalysisServiceLive";
import { experimentJsonColumns, toDataSource } from "../src/mappers";

const t = await makeTestD1();
afterAll(() => t.dispose());
const db = makeDrizzle(t.d1);

const H = 3_600_000;
const START = Date.UTC(2026, 9, 1);
const actor = { id: "user-1", email: "owner@example.com" };

const configs = {
  bigquery: BigQueryConfig.make({ projectId: "acme", dataset: "analytics", location: "US" }),
  snowflake: SnowflakeConfig.make({ account: "myorg-acme", user: "FURCA", warehouse: "WH", database: "ANALYTICS", schema: "PUBLIC", role: "" }),
  clickhouse: ClickHouseConfig.make({ url: "https://ch.example.com:8443", database: "analytics", username: "furca" }),
  postgres: PostgresConfig.make({ host: "db.example.com", port: 5432, database: "app", user: "furca", ssl: "require" }),
} satisfies Record<WarehouseType, WarehouseConfig>;

describe("warehouse config validation", () => {
  it.each([
    [{ ...configs.snowflake, account: "myorg-acme.snowflakecomputing.com" }, "Enter the account identifier, e.g. myorg-myaccount (the part before .snowflakecomputing.com)"],
    [{ ...configs.snowflake, account: "https://acme" }, "Enter the account identifier, e.g. myorg-myaccount (the part before .snowflakecomputing.com)"],
    [{ ...configs.snowflake, warehouse: " " }, "Warehouse is required"],
    [{ ...configs.clickhouse, url: "http://ch.example.com:8123" }, "Enter the HTTPS URL of the ClickHouse server, e.g. https://abc123.eu-west-1.aws.clickhouse.cloud:8443"],
    [{ ...configs.clickhouse, url: "https://furca:pw@ch.example.com" }, "Put the user name and password in their own fields, not in the URL"],
    [{ ...configs.postgres, host: "postgres://db.example.com" }, "Enter only the host name, e.g. db.example.com (no scheme, user or path)"],
    [{ ...configs.postgres, port: 70000 }, "Port must be a whole number from 1 to 65535"],
    [{ ...configs.bigquery, projectId: "" }, "Project ID is required"],
  ])("rejects %o with a readable message", (config, message) => {
    expect(checkConfig(config as WarehouseConfig)).toBe(message);
  });

  it("accepts locator-style Snowflake accounts and complete configs", () => {
    expect(checkConfig({ ...configs.snowflake, account: "xy12345.us-east-2.aws" } as WarehouseConfig)).toBeNull();
    for (const config of Object.values(configs)) expect(checkConfig(config)).toBeNull();
  });

  it("checks the secret's shape per type without echoing it", () => {
    expect(checkCredentials("snowflake", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc")).toContain("Encrypted private keys are not supported");
    expect(checkCredentials("snowflake", "-----BEGIN RSA PRIVATE KEY-----\nabc")).toContain("openssl pkcs8 -topk8 -nocrypt");
    expect(checkCredentials("snowflake", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBeNull();
    expect(checkCredentials("postgres", "")).toBe("Enter the password");
    expect(checkCredentials("clickhouse", "hunter2")).toBeNull();
    expect(checkCredentials("bigquery", "hunter2")).not.toContain("hunter2");
  });
});

describe("toDataSource", () => {
  const row = { name: "W", credentials: "x", exposureSql: "", createdAt: new Date(START), updatedAt: new Date(START) };

  it("decodes BigQuery rows stored before configs were tagged by their type column", () => {
    const source = toDataSource({ ...row, id: "bq", type: "bigquery", config: { projectId: "acme", dataset: "analytics", location: "US" } });
    expect(source.config).toBeInstanceOf(BigQueryConfig);
    expect(source.config).toMatchObject({ _tag: "bigquery", projectId: "acme", dataset: "analytics", location: "US" });
  });

  it("round-trips tagged configs and leaves the builtin source without one", () => {
    const encoded = Schema.encodeSync(PostgresConfig)(configs.postgres);
    expect(toDataSource({ ...row, id: "pg", type: "postgres", config: encoded }).config).toEqual(configs.postgres);
    expect(toDataSource({ ...row, id: "builtin", type: "builtin", config: null, credentials: null })).toMatchObject({ config: null, hasCredentials: false });
  });
});

describe("DataSourceService with warehouses", () => {
  const layer = DataSourceServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestDatabaseLayer(t.d1),
        Layer.succeed(CredentialCipher, { encrypt: (p) => Effect.succeed(`enc:${p}`), decrypt: (c) => Effect.succeed(c.slice(4)) }),
      ),
    ),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, DataSourceService>) => Effect.runPromise(Effect.provide(effect, layer));
  const fail = <A, E>(effect: Effect.Effect<A, E, DataSourceService>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), layer)) as Promise<{ _tag: string; message?: string }>;
  const stored = (id: string) => t.d1.prepare("select type, config, credentials from data_sources where id = ?").bind(id).first<Record<string, string>>();

  it("stores the type from the config tag and the password encrypted, keeps it on update with null, and never changes type", async () => {
    const input = { name: "Prod replica", config: configs.postgres, credentials: "s3cret", exposureSql: "SELECT * FROM exposures" };
    expect(await fail(DataSourceService.use((s) => s.create({ ...input, credentials: "" }, actor)))).toMatchObject({ message: "Enter the password" });
    expect(await fail(DataSourceService.use((s) => s.create({ ...input, config: { ...configs.postgres, port: 0 } as WarehouseConfig }, actor)))).toMatchObject({
      _tag: "ValidationError",
      message: "Port must be a whole number from 1 to 65535",
    });
    const source = await run(DataSourceService.use((s) => s.create(input, actor)));
    expect(source).toMatchObject({ type: "postgres", hasCredentials: true, config: configs.postgres });
    expect(JSON.stringify(source)).not.toContain("s3cret");
    const row = await stored(source.id);
    expect(row).toMatchObject({ type: "postgres", credentials: "enc:s3cret" });
    expect(JSON.parse(row!.config!)).toEqual({ _tag: "postgres", host: "db.example.com", port: 5432, database: "app", user: "furca", ssl: "require" });

    const moved = PostgresConfig.make({ ...configs.postgres, host: "db2.example.com" });
    const updated = await run(DataSourceService.use((s) => s.update({ id: source.id, ...input, config: moved, credentials: null }, actor)));
    expect(updated.config).toEqual(moved);
    expect((await stored(source.id))!.credentials).toBe("enc:s3cret");
    expect(await fail(DataSourceService.use((s) => s.update({ id: source.id, ...input, config: configs.clickhouse, credentials: null }, actor)))).toMatchObject({
      message: "A data source cannot change its type. Create a new data source instead",
    });
  });
});

describe("warehouse SQL dialects", () => {
  const metric = Metric.make({
    id: "m",
    key: "m",
    name: "m",
    description: "",
    type: "mean",
    dataSourceId: "w",
    definition: SqlMetricDefinition.make({ numeratorSql: "SELECT 1", denominatorSql: null }),
    inverse: false,
    windowHours: 72,
    delayHours: 1,
    capping: { type: "percentile", value: 0.99 },
    archived: false,
    createdAt: new Date(START),
    updatedAt: new Date(START),
  });
  const build = (type: WarehouseType) =>
    warehouseMomentsSql(type, {
      experimentKey: "exp",
      startMs: START,
      endMs: START + 10 * 24 * H,
      dimension: "country",
      cuped: true,
      metric,
      exposureSql: "SELECT * FROM exposures",
      numeratorSql: "SELECT * FROM orders",
      denominatorSql: null,
    });
  const fragments: Record<WarehouseType, ReadonlyArray<string>> = {
    bigquery: [
      "ARRAY_AGG(CAST(`country` AS STRING) IGNORE NULLS ORDER BY timestamp LIMIT 1)[SAFE_OFFSET(0)] AS dim",
      "timestamp >= TIMESTAMP_MILLIS(@start_ms)",
      "s.timestamp >= TIMESTAMP_MILLIS(UNIX_MILLIS(u.t0) + @delay_ms) AND s.timestamp < TIMESTAMP_MILLIS(UNIX_MILLIS(u.t0) + @window_ms)",
      "s.timestamp >= TIMESTAMP_MILLIS(UNIX_MILLIS(u.t0) - @lookback_ms) AND s.timestamp < u.t0",
      "APPROX_QUANTILES(y0, 1000)[OFFSET(CAST(ROUND(@cap_percentile * 1000) AS INT64))]",
      "FORMAT_DATE('%F', DATE(t0)) AS day",
    ],
    snowflake: [
      `GET(ARRAY_AGG(CAST("COUNTRY" AS VARCHAR)) WITHIN GROUP (ORDER BY timestamp), 0)::VARCHAR AS dim`,
      "timestamp >= TO_TIMESTAMP_LTZ(@start_ms, 3)",
      "s.timestamp >= DATEADD(millisecond, @delay_ms, u.t0) AND s.timestamp < DATEADD(millisecond, @window_ms, u.t0)",
      "s.timestamp >= DATEADD(millisecond, -@lookback_ms, u.t0)",
      "PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY y0)",
      "TO_CHAR(CONVERT_TIMEZONE('UTC', t0), 'YYYY-MM-DD') AS day",
    ],
    clickhouse: [
      "argMinIf(toString(`country`), timestamp, toString(`country`) IS NOT NULL) AS dim",
      "timestamp >= fromUnixTimestamp64Milli(@start_ms)",
      "s.timestamp >= addMilliseconds(u.t0, @delay_ms) AND s.timestamp < addMilliseconds(u.t0, @window_ms)",
      "s.timestamp >= subtractMilliseconds(u.t0, @lookback_ms)",
      "quantileExact(0.99)(y0)",
      "toFloat64(COALESCE(m.v, 0)) AS y0",
      "toString(toDate(t0, 'UTC')) AS day",
    ],
    postgres: [
      `(ARRAY_AGG(CAST("country" AS TEXT) ORDER BY timestamp) FILTER (WHERE CAST("country" AS TEXT) IS NOT NULL))[1] AS dim`,
      "timestamp >= to_timestamp(@start_ms / 1000.0)",
      "s.timestamp >= (u.t0 + @delay_ms * INTERVAL '1 millisecond') AND s.timestamp < (u.t0 + @window_ms * INTERVAL '1 millisecond')",
      "s.timestamp >= (u.t0 - @lookback_ms * INTERVAL '1 millisecond')",
      "PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY y0)",
      "to_char(t0, 'YYYY-MM-DD') AS day",
    ],
  };

  it.each(Object.keys(fragments) as WarehouseType[])("builds %s SQL with its own functions and the same parameters", (type) => {
    const q = build(type);
    for (const fragment of fragments[type]) expect(q.sql).toContain(fragment);
    // Same CTE structure and output columns in every dialect
    expect(q.sql).toContain("furca_exposure_source AS (\nSELECT * FROM exposures\n)");
    expect(q.sql).toMatch(/SELECT slice, variation, .+ AS day, COUNT\(\*\) AS n,[\s\S]+MAX\(cap\) AS cap_value\nFROM furca_capped GROUP BY slice, variation, day$/);
    expect(q.params).toEqual({
      experiment_key: "exp",
      start_ms: START,
      end_ms: START + 10 * 24 * H,
      delay_ms: H,
      window_ms: 72 * H,
      lookback_ms: 14 * 24 * H,
      cap_percentile: 0.99,
    });
  });

  it("never inlines a cap percentile outside [0, 1]", () => {
    const capped = Metric.make({ ...metric, capping: { type: "percentile", value: 2 } });
    const q = { experimentKey: "e", startMs: 0, endMs: 1, cuped: false, metric: capped, exposureSql: "x", numeratorSql: "x", denominatorSql: null };
    expect(() => warehouseMomentsSql("postgres", q)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The same rows from every warehouse, each in its client's native shape, must give the same result

describe("analysis parity across warehouses", () => {
  const counts = [
    ["control", 500],
    ["treatment", 480],
    [null, 3],
  ] as const;
  // variation, day, n, sum_y, sum_y2, sum_x, sum_x2, sum_xy
  const moments = [
    ["control", "2026-10-01", 300, 150, 400, 140, 380, 350],
    ["control", "2026-10-02", 200, 90, 250, 85, 240, 220],
    ["treatment", "2026-10-01", 280, 170, 460, 130, 360, 330],
    ["treatment", "2026-10-02", 200, 120, 330, 88, 250, 230],
  ] as const;
  const columns = ["variation", "day", "n", "sum_y", "sum_y2", "sum_x", "sum_x2", "sum_xy"] as const;
  const zeros = { sum_d: 0, sum_d2: 0, sum_yd: 0, cap_value: null };
  const isCounts = (sql: string) => sql.includes("AS users");
  const objects = <R extends ReadonlyArray<unknown>>(rows: ReadonlyArray<R>, names: ReadonlyArray<string>, cast: (v: unknown, i: number) => unknown = (v) => v) =>
    rows.map((r) => Object.fromEntries(names.map((n, i) => [n, cast(r[i], i)])));

  /** Snowflake jsonv2: upper-case names, every value a string */
  const snowflakeResult = (sql: string) => {
    const [names, rows, types] = isCounts(sql)
      ? [["VARIATION", "USERS"], counts, ["text", "fixed"]]
      : [[...columns.map((c) => c.toUpperCase()), "SUM_D", "SUM_D2", "SUM_YD", "CAP_VALUE"], moments.map((m) => [...m, 0, 0, 0, null]), ["text", "text", "fixed", "real", "real", "real", "real", "real", "real", "real", "real", "real"]];
    return Response.json({
      statementHandle: "h",
      resultSetMetaData: { rowType: names.map((name, i) => ({ name, type: types[i], scale: 0 })), partitionInfo: [{}] },
      data: rows.map((r) => r.map((v) => (v === null ? null : String(v)))),
    });
  };
  /** ClickHouse JSONEachRow: UInt64 counts quoted, floats as numbers */
  const clickHouseResult = (sql: string) => {
    const rows = isCounts(sql)
      ? objects(counts, ["variation", "users"], (v, i) => (i === 1 ? String(v) : v))
      : objects(moments, columns, (v, i) => (i === 2 ? String(v) : v)).map((r) => ({ ...r, ...zeros }));
    return new Response(rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  };
  /** porsager/postgres: bigint as strings, double precision as numbers */
  const postgresResult = (sql: string) =>
    isCounts(sql)
      ? objects(counts, ["variation", "users"], (v, i) => (i === 1 ? String(v) : v))
      : objects(moments, columns, (v, i) => (i === 2 ? String(v) : v)).map((r) => ({ ...r, ...zeros }));

  const requests: Partial<Record<WarehouseType, string[]>> = {};
  const record = (type: WarehouseType, sql: string) => (requests[type] ??= []).push(sql);
  const original = globalThis.fetch;
  const realPostgres = Postgres.driver.connect;
  let bigquery: ReturnType<typeof fakeBigQuery> | undefined;
  afterEach(() => {
    bigquery?.restore();
    globalThis.fetch = original;
    Postgres.driver.connect = realPostgres;
  });

  const layer = ExperimentAnalysisServiceLive.pipe(
    Layer.provide(Layer.mergeAll(TestDatabaseLayer(t.d1), Layer.succeed(CredentialCipher, { encrypt: Effect.succeed, decrypt: Effect.succeed }))),
  );
  const refresh = (id: string) => Effect.runPromise(Effect.provide(ExperimentAnalysisService.use((s) => s.refresh(id)), layer));

  it("returns identical health and metric results from BigQuery, Snowflake, ClickHouse and Postgres", async () => {
    const secrets: Record<WarehouseType, string> = {
      bigquery: JSON.stringify(await makeTestServiceAccount()),
      // any RSA PKCS#8 key: the fake Snowflake does not verify the JWT
      snowflake: (await makeTestServiceAccount()).private_key,
      clickhouse: "pw",
      postgres: "pw",
    };
    await db.insert(features).values({ id: "f1", key: "flag", valueType: "boolean", defaultValue: "false", tags: [] });
    for (const type of Object.keys(configs) as WarehouseType[]) {
      // BigQuery as stored before configs were tagged
      const config = type === "bigquery" ? { projectId: "acme", dataset: "analytics", location: "US" } : Schema.encodeSync(WarehouseConfig)(configs[type]);
      await db.insert(dataSources).values({ id: type, name: type, type, config, credentials: secrets[type], exposureSql: "SELECT * FROM exposures" });
      await db.insert(metrics).values({
        id: `${type}_revenue`,
        key: `${type}_revenue`,
        name: "Revenue",
        type: "mean",
        dataSourceId: type,
        definition: Schema.encodeSync(MetricDefinition)(SqlMetricDefinition.make({ numeratorSql: "SELECT user_id, timestamp, amount AS value FROM orders", denominatorSql: null })),
        capping: { type: "none" },
      });
      const e = Experiment.make({
        id: `${type}_exp`,
        key: `checkout_${type}`,
        name: type,
        hypothesis: "",
        status: "running",
        featureId: "f1",
        environmentIds: ["env_production"],
        analysisEnvironmentId: "env_production",
        hashAttribute: "id",
        dimensions: [],
        namespace: null,
        variations: [Variation.make({ key: "control", name: "Control", value: "false" }), Variation.make({ key: "treatment", name: "Treatment", value: "true" })],
        phases: [ExperimentPhase.make({ startedAt: new Date(START), endedAt: null, coverage: 1, weights: [0.5, 0.5], conditions: [], seed: "s", reason: "" })],
        coverage: 1,
        weights: [0.5, 0.5],
        conditions: [],
        dataSourceId: type,
        primaryMetricId: `${type}_revenue`,
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
      });
      await db.insert(experiments).values({ ...e, archivedAt: null, ...experimentJsonColumns(e) });
    }

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("snowflakecomputing.com")) {
        const { statement } = JSON.parse(String(init?.body)) as { statement: string };
        record("snowflake", statement);
        return snowflakeResult(statement);
      }
      if (url.startsWith("https://ch.example.com:8443")) {
        record("clickhouse", String(init?.body));
        return clickHouseResult(String(init?.body));
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;
    Postgres.driver.connect = (() => ({
      unsafe: async (text: string) => {
        record("postgres", text);
        return postgresResult(text);
      },
      end: async () => {},
    })) as unknown as typeof Postgres.driver.connect;
    const types = { variation: "STRING", day: "STRING", n: "INTEGER", sum_y: "FLOAT", sum_y2: "FLOAT", sum_x: "FLOAT", sum_x2: "FLOAT", sum_xy: "FLOAT" };
    bigquery = fakeBigQuery([
      { body: bqResult({ variation: "STRING", users: "INTEGER" }, counts) },
      { body: bqResult({ ...types, sum_d: "FLOAT", sum_d2: "FLOAT", sum_yd: "FLOAT", cap_value: "FLOAT" }, moments.map((m) => [...m, 0, 0, 0, null])) },
    ]);

    const results = [];
    for (const type of Object.keys(configs) as WarehouseType[]) {
      const snapshot = await refresh(`${type}_exp`);
      expect([type, snapshot.status, snapshot.error]).toEqual([type, "ok", null]);
      results.push({ health: snapshot.health, metrics: snapshot.metrics.map((m) => ({ ...m, metricId: "revenue" })) });
    }
    const [reference, ...others] = results;
    expect(reference!.health).toMatchObject({ totalUsers: 980, multipleExposureUsers: 3 });
    expect(reference!.metrics[0]!.variations.map((v) => v.users)).toEqual([500, 480]);
    expect(reference!.metrics[0]!.cupedApplied).toBe(true);
    expect(reference!.metrics[0]!.timeseries.map((p) => p.date)).toEqual(["2026-10-01", "2026-10-02"]);
    for (const other of others) expect(JSON.stringify(other)).toBe(JSON.stringify(reference));

    // Each warehouse got its own dialect, with parameters bound natively
    expect(bigquery.requests[0]!.body).toMatchObject({ parameterMode: "NAMED" });
    expect(requests.snowflake![0]).toContain("experiment_key = ? AND timestamp >= TO_TIMESTAMP_LTZ(?, 3)");
    expect(requests.clickhouse![0]).toContain("experiment_key = {experiment_key:String} AND timestamp >= fromUnixTimestamp64Milli({start_ms:Int64})");
    expect(requests.postgres![0]).toContain("experiment_key = CAST($1 AS TEXT) AND timestamp >= to_timestamp(CAST($2 AS BIGINT) / 1000.0)");
    expect(requests.postgres![1]).toContain("(u.t0 - CAST($5 AS BIGINT) * INTERVAL '1 millisecond')");
  });
});

describe("exposure counts SQL", () => {
  it("is the connection test query in every dialect and refuses dimension names that are not plain columns", () => {
    for (const type of ["bigquery", "snowflake", "clickhouse", "postgres"] as const) {
      const q = warehouseExposureCountsSql(type, { experimentKey: "e", startMs: 0, endMs: 1, exposureSql: "SELECT 1" });
      expect(q.sql).toMatch(/SELECT CASE WHEN nv > 1 THEN NULL ELSE arm END AS variation, COUNT\(\*\) AS users\nFROM furca_units GROUP BY 1$/);
      expect(() => warehouseExposureCountsSql(type, { experimentKey: "e", startMs: 0, endMs: 1, exposureSql: "SELECT 1", dimension: 'x" OR 1=1' })).toThrow();
    }
  });
});
