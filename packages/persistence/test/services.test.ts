import { afterAll, describe, expect, it } from "bun:test";
import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { BigQueryConfig } from "@furca/core/datasources/DataSource";
import { DataSourceService } from "@furca/core/datasources/DataSourceService";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import { EnvironmentService } from "@furca/core/environments/EnvironmentService";
import { defaultStatsSettings, ExperimentPlan, Variation } from "@furca/core/experiments/Experiment";
import { type ExperimentDraft, ExperimentService } from "@furca/core/experiments/ExperimentService";
import { ExperimentRule, ForceRule, RolloutRule } from "@furca/core/features/Feature";
import { FeatureService } from "@furca/core/features/FeatureService";
import { EventSource, EventMetricDefinition, SqlMetricDefinition } from "@furca/core/metrics/Metric";
import { MetricService } from "@furca/core/metrics/MetricService";
import { makeTestD1, TestDatabaseLayer } from "@furca/database/testing/TestDatabase";
import type { SdkPayload } from "@furca/sdk/types";
import { Effect, Layer } from "effect";
import { DataSourceServiceLive } from "../src/Layers/DataSourceServiceLive";
import { EnvironmentServiceLive } from "../src/Layers/EnvironmentServiceLive";
import { ExperimentServiceLive } from "../src/Layers/ExperimentServiceLive";
import { FeatureServiceLive } from "../src/Layers/FeatureServiceLive";
import { MetricServiceLive } from "../src/Layers/MetricServiceLive";

const t = await makeTestD1();
afterAll(() => t.dispose());

const kv = new Map<string, string>();
const layer = Layer.mergeAll(FeatureServiceLive, ExperimentServiceLive, EnvironmentServiceLive, MetricServiceLive, DataSourceServiceLive).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TestDatabaseLayer(t.d1),
      Layer.succeed(CredentialCipher, {
        encrypt: (plain) => Effect.succeed(`enc:${plain}`),
        decrypt: (cipher) => Effect.succeed(cipher.slice(4)),
      }),
      Layer.succeed(PayloadStore, {
        put: (key, json) => Effect.sync(() => void kv.set(key, json)),
        get: (key) => Effect.sync(() => kv.get(key) ?? null),
        remove: (key) => Effect.sync(() => void kv.delete(key)),
      }),
    ),
  ),
);

type Services = FeatureService | ExperimentService | EnvironmentService | MetricService | DataSourceService;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(effect, layer));
const fail = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(Effect.provide(Effect.flip(effect), layer)) as Promise<{ _tag: string; message?: string }>;

const actor = { id: "user-1", email: "owner@example.com" };
const PROD = "env_production";
const DEV = "env_development";

const environments = await run(EnvironmentService.use((s) => s.list));
const sdkKey = (id: string) => environments.find((e) => e.environment.id === id)!.environment.sdkKey;
const payload = (environmentId: string): SdkPayload => JSON.parse(kv.get(sdkKey(environmentId))!);

const metric = await run(
  MetricService.use((s) =>
    s.create(
      {
        key: "purchase",
        name: "Purchase",
        description: "",
        type: "proportion",
        dataSourceId: "builtin",
        definition: EventMetricDefinition.make({ numerator: EventSource.make({ event: "purchase", aggregation: "count", filters: [] }), denominator: null }),
        inverse: false,
        windowHours: null,
        delayHours: 0,
        capping: { type: "none" },
      },
      actor,
    ),
  ),
);

const createFlag = (key: string, valueType: "boolean" | "string" | "number" | "json" = "string", defaultValue = '"control"') =>
  run(FeatureService.use((s) => s.create({ key, description: "", valueType, defaultValue, tags: [] }, actor)));

const draft = (featureId: string, overrides: Partial<ExperimentDraft> = {}): ExperimentDraft => ({
  name: "Checkout test",
  dimensions: [],
  namespace: null,
  hypothesis: "Blue converts better",
  featureId,
  environmentIds: [PROD],
  analysisEnvironmentId: PROD,
  hashAttribute: "id",
  variations: [
    Variation.make({ key: "control", name: "Control", value: '"control"' }),
    Variation.make({ key: "blue", name: "Blue", value: '"blue"' }),
  ],
  coverage: 0.5,
  weights: [0.5, 0.5],
  conditions: [],
  dataSourceId: "builtin",
  primaryMetricId: metric.id,
  secondaryMetricIds: [],
  guardrailMetricIds: [],
  stats: defaultStatsSettings(),
  plan: ExperimentPlan.make({ mde: 0.05, sampleSizePerVariation: null, dailyTraffic: null }),
  ...overrides,
});

describe("features", () => {
  it("publishes a flag enabled in production with JSON-parsed values, and keeps it out of other environments", async () => {
    const flag = await createFlag("banner", "json", '{"color":"red"}');
    expect(flag.environments.map((e) => [e.environmentId, e.enabled])).toEqual([
      [PROD, false],
      [DEV, false],
    ]);
    await run(FeatureService.use((s) => s.setEnabled({ id: flag.id, environmentId: PROD, enabled: true }, actor)));
    await run(
      FeatureService.use((s) =>
        s.saveRules(
          {
            id: flag.id,
            environmentId: PROD,
            rules: [
              ForceRule.make({ id: "r1", description: "", enabled: true, conditions: [], value: '{"color":"blue"}' }),
              ForceRule.make({ id: "r2", description: "", enabled: false, conditions: [], value: '{"color":"green"}' }),
              RolloutRule.make({ id: "r3", description: "", enabled: true, conditions: [], value: "[1,2]", coverage: 0.3, hashAttribute: "id", seed: "s" }),
            ],
          },
          actor,
        ),
      ),
    );
    const prod = payload(PROD);
    expect(prod.environment).toBe("production");
    expect(prod.features.banner).toEqual({
      defaultValue: { color: "red" },
      rules: [
        { type: "force", conditions: [], value: { color: "blue" } },
        { type: "rollout", conditions: [], value: [1, 2], coverage: 0.3, hashAttribute: "id", seed: "s" },
      ],
    });
    expect(payload(DEV).features.banner).toBeUndefined();
  });

  it("drops archived flags from the payload", async () => {
    const flag = await createFlag("old-flag");
    await run(FeatureService.use((s) => s.setEnabled({ id: flag.id, environmentId: PROD, enabled: true }, actor)));
    expect(payload(PROD).features["old-flag"]).toBeDefined();
    await run(FeatureService.use((s) => s.archive({ id: flag.id, archived: true }, actor)));
    expect(payload(PROD).features["old-flag"]).toBeUndefined();
  });

  it("rejects a duplicate key and an invalid default value", async () => {
    await createFlag("dup");
    expect((await fail(FeatureService.use((s) => s.create({ key: "dup", description: "", valueType: "string", defaultValue: '"x"', tags: [] }, actor)))).message).toBe(
      'A flag with key "dup" already exists',
    );
    expect((await fail(FeatureService.use((s) => s.create({ key: "num", description: "", valueType: "number", defaultValue: '"x"', tags: [] }, actor))))._tag).toBe(
      "ValidationError",
    );
  });

  it("saveRules rejects a value of the wrong type", async () => {
    const flag = await createFlag("typed", "boolean", "false");
    const error = await fail(
      FeatureService.use((s) =>
        s.saveRules(
          { id: flag.id, environmentId: PROD, rules: [ForceRule.make({ id: "r", description: "", enabled: true, conditions: [], value: '"yes"' })] },
          actor,
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "ValidationError", message: "Rule 1: Expected true or false" });
  });
});

describe("experiments", () => {
  it("create inserts its rule at the top of each selected environment and saveRules cannot remove it", async () => {
    const flag = await createFlag("cta");
    const existing = ForceRule.make({ id: "qa", description: "QA", enabled: true, conditions: [], value: '"qa"' });
    await run(FeatureService.use((s) => s.saveRules({ id: flag.id, environmentId: PROD, rules: [existing] }, actor)));
    const experiment = await run(ExperimentService.use((s) => s.create({ key: "cta-test", ...draft(flag.id) }, actor)));
    expect(experiment.status).toBe("draft");

    const after = await run(FeatureService.use((s) => s.get(flag.id)));
    const prodRules = after.environments.find((e) => e.environmentId === PROD)!.rules;
    expect(prodRules.map((r) => r._tag)).toEqual(["experiment", "force"]);
    expect(prodRules[0]).toMatchObject({ experimentId: experiment.id, enabled: true });
    expect(after.environments.find((e) => e.environmentId === DEV)!.rules).toEqual([]);

    const removed = await fail(FeatureService.use((s) => s.saveRules({ id: flag.id, environmentId: PROD, rules: [existing] }, actor)));
    expect(removed._tag).toBe("ValidationError");
    // Reordering and toggling are fine
    const toggled = ExperimentRule.make({ ...(prodRules[0] as ExperimentRule), enabled: false });
    await run(FeatureService.use((s) => s.saveRules({ id: flag.id, environmentId: PROD, rules: [existing, toggled] }, actor)));
  });

  it("serves the experiment only while running, with phase 0 traffic and seed", async () => {
    const flag = await createFlag("hero");
    await run(FeatureService.use((s) => s.setEnabled({ id: flag.id, environmentId: PROD, enabled: true }, actor)));
    const created = await run(ExperimentService.use((s) => s.create({ key: "hero-test", ...draft(flag.id) }, actor)));
    expect(payload(PROD).features.hero!.rules).toEqual([]);

    const started = await run(ExperimentService.use((s) => s.start(created.id, actor)));
    expect(started.status).toBe("running");
    expect(started.phases).toHaveLength(1);
    const phase0 = started.phases[0]!;
    expect(phase0.seed).toMatch(/^[0-9a-f]{16}$/);
    expect(payload(PROD).features.hero!.rules).toEqual([
      {
        type: "experiment",
        key: "hero-test",
        conditions: [],
        coverage: 0.5,
        hashAttribute: "id",
        seed: phase0.seed,
        phase: 0,
        variations: [
          { key: "control", value: "control" },
          { key: "blue", value: "blue" },
        ],
        weights: [0.5, 0.5],
      },
    ]);
  });

  it("updateTraffic: a coverage increase edits the phase, a weight change opens a new phase with a new seed", async () => {
    const flag = await createFlag("pricing");
    await run(FeatureService.use((s) => s.setEnabled({ id: flag.id, environmentId: PROD, enabled: true }, actor)));
    const created = await run(ExperimentService.use((s) => s.create({ key: "pricing-test", ...draft(flag.id) }, actor)));
    const started = await run(ExperimentService.use((s) => s.start(created.id, actor)));
    const seed0 = started.phases[0]!.seed;

    const wider = await run(
      ExperimentService.use((s) => s.updateTraffic({ id: created.id, coverage: 0.8, weights: [0.5, 0.5], conditions: [], reason: "" }, actor)),
    );
    expect(wider.phases).toHaveLength(1);
    expect(wider.phases[0]).toMatchObject({ coverage: 0.8, seed: seed0, endedAt: null });

    const reweighted = await run(
      ExperimentService.use((s) =>
        s.updateTraffic({ id: created.id, coverage: 0.8, weights: [0.2, 0.8], conditions: [], reason: "Favor treatment" }, actor),
      ),
    );
    expect(reweighted.phases).toHaveLength(2);
    expect(reweighted.phases[0]!.endedAt).toBeInstanceOf(Date);
    const phase1 = reweighted.phases[1]!;
    expect(phase1).toMatchObject({ coverage: 0.8, weights: [0.2, 0.8], reason: "Favor treatment", endedAt: null });
    expect(phase1.seed).not.toBe(seed0);
    expect(payload(PROD).features.pricing!.rules[0]).toMatchObject({ seed: phase1.seed, phase: 1, weights: [0.2, 0.8] });

    const stored = await run(ExperimentService.use((s) => s.get(created.id)));
    expect(stored.weights).toEqual([0.2, 0.8]);
    expect(stored.phases.map((p) => p.seed)).toEqual([seed0, phase1.seed]);
  });

  it("stop with ship replaces the experiment rule with a force rule serving the variation", async () => {
    const flag = await createFlag("ship-me");
    await run(FeatureService.use((s) => s.setEnabled({ id: flag.id, environmentId: PROD, enabled: true }, actor)));
    const created = await run(ExperimentService.use((s) => s.create({ key: "ship-test", ...draft(flag.id) }, actor)));
    await run(ExperimentService.use((s) => s.start(created.id, actor)));
    const noVariation = await fail(
      ExperimentService.use((s) => s.stop({ id: created.id, outcome: "ship", variationKey: null, reason: "" }, actor)),
    );
    expect(noVariation._tag).toBe("ValidationError");

    const stopped = await run(
      ExperimentService.use((s) => s.stop({ id: created.id, outcome: "ship", variationKey: "blue", reason: "Won" }, actor)),
    );
    expect(stopped.status).toBe("stopped");
    expect(stopped.phases.at(-1)!.endedAt).toBeInstanceOf(Date);
    expect(stopped.decision).toMatchObject({ outcome: "ship", variationKey: "blue", decidedBy: actor.email });

    const rules = (await run(FeatureService.use((s) => s.get(flag.id)))).environments.find((e) => e.environmentId === PROD)!.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ _tag: "force", enabled: true, value: '"blue"', description: "Shipped from experiment Checkout test" });
    expect(payload(PROD).features["ship-me"]!.rules).toEqual([{ type: "force", conditions: [], value: "blue" }]);
  });

  it("only name, hypothesis and secondary / guardrail metrics change after start", async () => {
    const flag = await createFlag("locked");
    const created = await run(ExperimentService.use((s) => s.create({ key: "locked-test", ...draft(flag.id) }, actor)));
    const started = await run(ExperimentService.use((s) => s.start(created.id, actor)));
    const renamed = await run(ExperimentService.use((s) => s.update({ ...started, name: "Renamed" }, actor)));
    expect(renamed.name).toBe("Renamed");
    const error = await fail(ExperimentService.use((s) => s.update({ ...started, coverage: 0.9 }, actor)));
    expect(error.message).toContain("changed: coverage");
  });

  it("rejects weights that do not sum to 1 and flags with features referenced by experiments cannot be deleted", async () => {
    const flag = await createFlag("weights");
    const bad = await fail(ExperimentService.use((s) => s.create({ key: "weights-test", ...draft(flag.id, { weights: [0.5, 0.4] }) }, actor)));
    expect(bad.message).toBe("Weights must add up to 100%");
    await run(ExperimentService.use((s) => s.create({ key: "weights-ok", ...draft(flag.id) }, actor)));
    expect((await fail(FeatureService.use((s) => s.delete(flag.id, actor))))._tag).toBe("ConflictError");
  });
});

describe("environments", () => {
  it("create adds disabled rows for existing flags and publishes; delete refuses while an experiment runs there", async () => {
    const flag = await createFlag("env-flag");
    const staging = await run(EnvironmentService.use((s) => s.create({ key: "staging", name: "Staging" }, actor)));
    expect(staging.sdkKey).toMatch(/^sdk-[0-9a-f]{24}$/);
    const config = (await run(FeatureService.use((s) => s.get(flag.id)))).environments.find((e) => e.environmentId === staging.id);
    expect(config).toMatchObject({ enabled: false, rules: [] });
    expect(JSON.parse(kv.get(staging.sdkKey)!).environment).toBe("staging");

    const experiment = await run(
      ExperimentService.use((s) => s.create({ key: "staging-test", ...draft(flag.id, { environmentIds: [staging.id], analysisEnvironmentId: staging.id }) }, actor)),
    );
    await run(ExperimentService.use((s) => s.start(experiment.id, actor)));
    expect((await fail(EnvironmentService.use((s) => s.delete(staging.id, actor))))._tag).toBe("ConflictError");
    await run(ExperimentService.use((s) => s.stop({ id: experiment.id, outcome: "rollback", variationKey: null, reason: "" }, actor)));

    const rotated = await run(EnvironmentService.use((s) => s.rotateSdkKey(staging.id, actor)));
    expect(kv.has(staging.sdkKey)).toBe(false);
    expect(kv.has(rotated.sdkKey)).toBe(true);
    await run(EnvironmentService.use((s) => s.delete(staging.id, actor)));
    expect(kv.has(rotated.sdkKey)).toBe(false);
    const list = await run(EnvironmentService.use((s) => s.list));
    expect(list.map((e) => e.environment.key)).toEqual(["production", "development"]);
  });
});

describe("data sources and metrics", () => {
  const bigquery = BigQueryConfig.make({ projectId: "proj", dataset: "analytics", location: "US" });
  const key = JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----" });
  const credentials = (id: string) =>
    t.d1.prepare("select credentials from data_sources where id = ?").bind(id).first<{ credentials: string | null }>();

  it("stores BigQuery credentials encrypted, keeps them on update with null, and never returns them", async () => {
    const bad = await fail(
      DataSourceService.use((s) => s.createBigQuery({ name: "BQ", bigquery, credentialsJson: '{"type":"x"}', exposureSql: "select 1" }, actor)),
    );
    expect(bad._tag).toBe("ValidationError");
    const source = await run(DataSourceService.use((s) => s.createBigQuery({ name: "BQ", bigquery, credentialsJson: key, exposureSql: "select 1" }, actor)));
    expect(source).toMatchObject({ type: "bigquery", hasCredentials: true });
    expect(JSON.stringify(source)).not.toContain("private_key");
    expect((await credentials(source.id))!.credentials).toBe(`enc:${key}`);
    await run(
      DataSourceService.use((s) => s.update({ id: source.id, name: "Renamed", bigquery, credentialsJson: null, exposureSql: "select 2" }, actor)),
    );
    expect((await credentials(source.id))!.credentials).toBe(`enc:${key}`);

    const sqlMetric = {
      key: "revenue",
      name: "Revenue",
      description: "",
      type: "mean" as const,
      dataSourceId: source.id,
      definition: SqlMetricDefinition.make({ numeratorSql: "select 1", denominatorSql: null }),
      inverse: false,
      windowHours: null,
      delayHours: 0,
      capping: { type: "percentile" as const, value: 0.99 },
    };
    const ratioWithout = await fail(MetricService.use((s) => s.create({ ...sqlMetric, type: "ratio" }, actor)));
    expect(ratioWithout.message).toBe("Ratio metrics need a denominator");
    const wrongKind = await fail(MetricService.use((s) => s.create({ ...sqlMetric, dataSourceId: "builtin" }, actor)));
    expect(wrongKind._tag).toBe("ValidationError");
    const created = await run(MetricService.use((s) => s.create(sqlMetric, actor)));
    expect((await run(MetricService.use((s) => s.get(created.id)))).capping).toEqual({ type: "percentile", value: 0.99 });

    expect((await fail(DataSourceService.use((s) => s.delete(source.id, actor))))._tag).toBe("ConflictError");
    expect((await fail(DataSourceService.use((s) => s.delete("builtin", actor))))._tag).toBe("ConflictError");
  });
});
