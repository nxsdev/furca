import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { EventStatsService } from "@furca/core/analysis/Analysis";
import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { WarehouseTester } from "@furca/core/datasources/WarehouseTester";
import { makeDrizzle } from "@furca/database/Database";
import { dataSources } from "@furca/database/schema/index";
import { makeTestD1, TestDatabaseLayer } from "@furca/database/testing/TestDatabase";
import { fakeBigQuery, makeTestServiceAccount } from "@furca/integrations/bigquery/testing";
import { Effect, Layer } from "effect";
import { EventStatsServiceLive } from "../src/Layers/EventStatsServiceLive";
import { WarehouseTesterLive } from "../src/Layers/WarehouseTesterLive";
import { toDataSource } from "../src/mappers";

const t = await makeTestD1();
afterAll(() => t.dispose());
const db = makeDrizzle(t.d1);

const layer = Layer.mergeAll(EventStatsServiceLive, WarehouseTesterLive).pipe(
  Layer.provide(Layer.mergeAll(TestDatabaseLayer(t.d1), Layer.succeed(CredentialCipher, { encrypt: Effect.succeed, decrypt: Effect.succeed }))),
);
const run = <A, E>(effect: Effect.Effect<A, E, EventStatsService | WarehouseTester>) => Effect.runPromise(Effect.provide(effect, layer));

const H = 3_600_000;
const now = Date.now();
const PROD = "env_production";
const event = (name: string, ts: number, env = PROD) =>
  t.d1.prepare("INSERT INTO events (environment_id, user_id, name, value, ts) VALUES (?1, 'u', ?2, NULL, ?3)").bind(env, name, ts);
const exposure = (user: string, ts: number) =>
  t.d1
    .prepare("INSERT INTO exposures (environment_id, experiment_key, variation_key, user_id, first_seen_at) VALUES (?1, 'exp', 'control', ?2, ?3)")
    .bind(PROD, user, ts);
await t.d1.batch([
  event("purchase", now - H),
  event("purchase", now - 2 * H),
  event("purchase", now - 40 * 24 * H), // older than 30 days
  event("signup", now - 10 * 60_000),
  ...Array.from({ length: 5 }, () => event("page_view", now - 25 * H)),
  ...Array.from({ length: 10 }, () => event("purchase", now - H, "env_development")),
  exposure("a", now - H),
  exposure("b", now - H),
  exposure("c", now - 30 * H),
]);

describe("EventStatsService", () => {
  it("lists event names of the last 30 days in one environment, most frequent first", async () => {
    const names = await run(EventStatsService.use((s) => s.names(PROD)));
    expect(names.map((n) => [n.name, n.count])).toEqual([
      ["page_view", 5],
      ["purchase", 2],
      ["signup", 1],
    ]);
    expect(names[1]!.lastSeenAt.getTime()).toBe(now - H);
  });

  it("returns 24 hourly buckets ending with the current hour, empty hours included", async () => {
    const buckets = await run(EventStatsService.use((s) => s.volume(PROD)));
    const currentHour = Math.floor(Date.now() / H) * H;
    expect(buckets).toHaveLength(24);
    expect(buckets.at(-1)!.hour.getTime()).toBe(currentHour);
    expect(buckets[0]!.hour.getTime()).toBe(currentHour - 23 * H);
    const at = (ts: number) => buckets.find((b) => b.hour.getTime() === Math.floor(ts / H) * H)!;
    expect(at(now - H)).toMatchObject({ exposures: 2 });
    expect(buckets.reduce((s, b) => s + b.events, 0)).toBe(3);
    expect(buckets.reduce((s, b) => s + b.exposures, 0)).toBe(2);
    expect(buckets.filter((b) => b.events === 0 && b.exposures === 0).length).toBeGreaterThanOrEqual(20);
  });
});

describe("WarehouseTester", () => {
  let fake: ReturnType<typeof fakeBigQuery> | undefined;
  afterEach(() => fake?.restore());
  const test = (id: string) =>
    run(
      Effect.gen(function* () {
        const row = yield* Effect.promise(() => db.query.dataSources.findFirst({ where: { id } }));
        return yield* (yield* WarehouseTester).test(toDataSource(row!));
      }),
    );

  it("reports the built-in store's event count of the last 30 days across environments", async () => {
    expect(await test("builtin")).toEqual({ ok: true, message: "Built-in event store: 18 events in the last 30 days", bytesProcessed: null });
  });

  it("dry-runs the wrapped exposure SQL on BigQuery and returns the bytes it would process", async () => {
    const sa = await makeTestServiceAccount();
    await db.insert(dataSources).values([
      { id: "bq", name: "BQ", type: "bigquery", config: { projectId: "acme", dataset: "analytics", location: "US" }, credentials: JSON.stringify(sa), exposureSql: "SELECT * FROM exposures" },
      { id: "bq_nokey", name: "BQ", type: "bigquery", config: { projectId: "acme", dataset: "analytics", location: "US" }, credentials: null, exposureSql: "" },
    ]);
    fake = fakeBigQuery([{ body: { totalBytesProcessed: "2500000" } }]);
    expect(await test("bq")).toEqual({
      ok: true,
      message: `Connected as ${sa.client_email}. The exposure SQL is valid (dry run scans 2.5 MB)`,
      bytesProcessed: 2_500_000,
    });
    expect(fake.requests[0]!.body).toMatchObject({ dryRun: true, parameterMode: "NAMED" });
  });

  it("never fails: warehouse errors and missing credentials become ok=false with a message", async () => {
    fake = fakeBigQuery([{ status: 400, body: { error: { message: "Unrecognized name: variation_id at [9:3]" } } }]);
    expect(await test("bq")).toEqual({ ok: false, message: "BigQuery: Unrecognized name: variation_id at [9:3]", bytesProcessed: null });
    expect(await test("bq_nokey")).toEqual({ ok: false, message: "Add a service account key JSON", bytesProcessed: null });
  });
});
