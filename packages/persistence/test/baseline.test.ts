import { afterAll, describe, expect, it } from "bun:test";
import { EventStatsService } from "@furca/core/analysis/Analysis";
import { EventSource, PropertyFilter } from "@furca/core/metrics/Metric";
import { makeTestD1, TestDatabaseLayer } from "@furca/database/testing/TestDatabase";
import { Effect, Layer } from "effect";
import { EventStatsServiceLive } from "../src/Layers/EventStatsServiceLive";

const t = await makeTestD1();
afterAll(() => t.dispose());
const layer = EventStatsServiceLive.pipe(Layer.provide(TestDatabaseLayer(t.d1)));
const run = <A, E>(effect: Effect.Effect<A, E, EventStatsService>) => Effect.runPromise(Effect.provide(effect, layer));

const DAY = 86_400_000;
const now = Date.now();
const ENV = "env_production";
const event = (user: string, name: string, value: number | null, ageDays: number, properties: object | null = null, env = ENV) =>
  t.d1
    .prepare("INSERT INTO events (environment_id, user_id, name, value, ts, properties) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(env, user, name, value, now - ageDays * DAY, properties === null ? null : JSON.stringify(properties));
const exposure = (user: string, ageDays: number) =>
  t.d1
    .prepare("INSERT INTO exposures (environment_id, experiment_key, variation_key, user_id, first_seen_at) VALUES (?1, 'old', 'control', ?2, ?3)")
    .bind(ENV, user, now - ageDays * DAY);

// 10 days of data. Users a–d have page views, e only an exposure; f's purchase is older than the window
await t.d1.batch([
  event("a", "page_view", null, 10),
  event("b", "page_view", null, 2),
  event("c", "page_view", null, 1),
  event("d", "page_view", null, 1),
  exposure("e", 3),
  event("a", "purchase", 30, 2, { plan: "pro" }),
  event("a", "purchase", 10, 1, { plan: "free" }),
  event("b", "purchase", 20, 1, { plan: "pro" }),
  event("f", "purchase", 99, 40),
  event("x", "purchase", 50, 1, null, "env_development"),
]);

const source = (aggregation: "count" | "sum", filters: ReadonlyArray<PropertyFilter> = []) =>
  new EventSource({ event: "purchase", aggregation, filters });
const baseline = (type: "proportion" | "mean", s: EventSource, days = 28) =>
  run(EventStatsService.use((svc) => svc.baseline(ENV, { type, source: s }, days)));

describe("EventStatsService.baseline", () => {
  it("rates a proportion metric over users with any event or exposure, per day of data actually seen", async () => {
    const b = await baseline("proportion", source("count"));
    // a, b, c, d, e; the store has 10 days of events, so 5 users over 10 days
    expect(b).toEqual({ days: 10, users: 5, dailyUsers: 0.5, rate: 0.4, mean: null, stdDev: null });
  });

  it("gives a mean metric's per-user mean and sample standard deviation, counting users without the event as 0", async () => {
    const b = await baseline("mean", source("sum"));
    // revenue per user: a 40, b 20, c 0, d 0, e 0
    expect(b?.mean).toBe(12);
    expect(b?.stdDev).toBeCloseTo(Math.sqrt((28 ** 2 + 8 ** 2 + 3 * 12 ** 2) / 4), 9);
    expect((await baseline("mean", source("count")))?.mean).toBe(0.6);
  });

  it("applies the metric's property filters and the requested window", async () => {
    const pro = await baseline("proportion", source("count", [new PropertyFilter({ property: "plan", operator: "eq", values: ["pro"] })]));
    expect(pro?.rate).toBe(0.4);
    const free = await baseline("mean", source("sum", [new PropertyFilter({ property: "plan", operator: "eq", values: ["free"] })]));
    expect(free?.mean).toBe(2);
    // Last 2 days: a and b (purchases a day ago), c and d; e's exposure and the 2-day-old events fall outside.
    // The oldest event left is a day old, so that is 1 day of traffic
    const recent = await baseline("proportion", source("count"), 2);
    expect(recent).toMatchObject({ days: 1, users: 4, dailyUsers: 4, rate: 0.5 });
  });

  it("returns null for an environment without users", async () => {
    expect(await run(EventStatsService.use((svc) => svc.baseline("env_staging", { type: "proportion", source: source("count") }, 28)))).toBeNull();
  });
});
