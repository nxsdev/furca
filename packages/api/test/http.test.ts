import { afterAll, describe, expect, it } from "bun:test";
import { makeTestD1 } from "@furca/database/testing/TestDatabase";
import type { FurcaEnv } from "../src/Runtime/Env";
import { handleApiRequest } from "../src/Runtime/WorkerEntry";

const t = await makeTestD1();
afterAll(() => t.dispose());

const kv = new Map<string, string>();
const env: FurcaEnv = {
  DB: t.d1,
  KV: {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => void kv.set(key, value),
    delete: async (key: string) => void kv.delete(key),
  } as unknown as KVNamespace,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  ENCRYPTION_KEY: "test-encryption-key-test-encryption-key",
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const ORIGIN = "http://localhost";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const request = (path: string, init: RequestInit = {}) =>
  handleApiRequest(new Request(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, "user-agent": BROWSER, ...init.headers } }), env, ctx);

const signUp = async (email: string) => {
  const res = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { id: body.user.id, cookie };
};

const rpc = async (cookie: string, path: string, input?: unknown) => {
  const res = await request(`/api/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ json: input }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : (JSON.parse(text) as { json: any }).json };
};

const productionSdkKey = async () =>
  (await t.d1.prepare("select sdk_key from environments where id = 'env_production'").first<{ sdk_key: string }>())!.sdk_key;

const owner = await signUp("owner@example.com");

describe("rpc wire format", () => {
  it("serializes Dates inside domain entities so clients receive Date objects", async () => {
    const res = await request("/api/rpc/features/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ json: { key: "wire-dates", description: "", valueType: "boolean", defaultValue: "false", tags: [] } }),
    });
    const body = (await res.json()) as { meta?: ReadonlyArray<ReadonlyArray<string | number>> };
    const datePaths = (body.meta ?? []).filter((m) => m[0] === "date").map((m) => m.slice(1).join("."));
    expect(datePaths).toEqual(expect.arrayContaining(["createdAt", "updatedAt"]));
  });
});

describe("members", () => {
  it("only the owner removes members, and never themselves", async () => {
    const invite = await rpc(owner.cookie, "members/invite", { email: "  Member@Example.com " });
    expect(invite.status).toBe(200);
    expect(invite.json.email).toBe("member@example.com");
    expect(invite.json.url).toMatch(/^\/invite\/[0-9a-f]{64}$/);

    const member = await signUp("member@example.com");
    expect((await rpc(owner.cookie, "members/invite", { email: "member@example.com" })).status).toBe(400);

    expect((await rpc(member.cookie, "members/remove", { id: owner.id })).status).toBe(403);
    expect((await rpc(owner.cookie, "members/remove", { id: owner.id })).status).toBe(403);
    expect((await rpc(owner.cookie, "members/remove", { id: member.id })).status).toBe(200);

    const list = await rpc(owner.cookie, "members/list");
    expect(list.json.members.map((m: { email: string; isOwner: boolean }) => [m.email, m.isOwner])).toEqual([["owner@example.com", true]]);
    expect(list.json.invitations).toEqual([]);
  });

  it("re-inviting replaces the pending invitation", async () => {
    const first = await rpc(owner.cookie, "members/invite", { email: "again@example.com" });
    const second = await rpc(owner.cookie, "members/invite", { email: "again@example.com" });
    const list = await rpc(owner.cookie, "members/list");
    expect(list.json.invitations.map((i: { id: string }) => i.id)).toEqual([second.json.id]);
    expect(second.json.id).not.toBe(first.json.id);
  });
});

describe("SDK payload endpoint", () => {
  it("builds and stores the payload on a KV miss, with a flag created and enabled over RPC", async () => {
    const created = await rpc(owner.cookie, "features/create", {
      key: "new-checkout",
      description: "",
      valueType: "boolean",
      defaultValue: "true",
      tags: [],
    });
    expect(created.status).toBe(200);
    expect((await rpc(owner.cookie, "features/create", { ...created.json, tags: [] })).json.message).toBe(
      'A flag with key "new-checkout" already exists',
    );
    await rpc(owner.cookie, "features/setEnabled", { id: created.json.id, environmentId: "env_production", enabled: true });

    const sdkKey = await productionSdkKey();
    kv.clear();
    const res = await request(`/api/sdk/v1/payload/${sdkKey}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=30, stale-while-revalidate=300");
    const payload = (await res.json()) as { environment: string; features: Record<string, unknown> };
    expect(payload.environment).toBe("production");
    expect(payload.features["new-checkout"]).toEqual({ defaultValue: true, rules: [] });
    expect(kv.get(`payload:${sdkKey}`)).toBeDefined();
  });

  it("returns 404 for an unknown SDK key and 204 with CORS for preflight", async () => {
    expect((await request("/api/sdk/v1/payload/sdk-nope")).status).toBe(404);
    const preflight = await request("/api/sdk/v1/events/sdk-nope", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("SDK events endpoint", () => {
  const post = (sdkKey: string, body: unknown, headers: Record<string, string> = {}) =>
    request(`/api/sdk/v1/events/${sdkKey}`, {
      method: "POST",
      headers: { "content-type": "text/plain", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const exposureRows = () =>
    t.d1.prepare("select user_id, variation_key, first_seen_at from exposures order by user_id, variation_key").all().then((r) => r.results);

  it("accepts a text/plain body and keeps the first exposure per unit and variation", async () => {
    const sdkKey = await productionSdkKey();
    const now = Date.now();
    const exposure = { experimentKey: "exp", variationKey: "control", userId: "u1", ts: now - 2000 };
    const first = await post(sdkKey, {
      exposures: [exposure, { ...exposure, ts: now - 1000 }, { ...exposure, userId: "u2" }],
      events: [
        { name: "purchase", userId: "u1", value: 12.5, ts: now },
        { name: "purchase", userId: "u1", ts: now - 8 * 24 * 3600 * 1000 },
      ],
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: 4 });
    await post(sdkKey, { exposures: [{ ...exposure, ts: now }] });

    expect(await exposureRows()).toEqual([
      { user_id: "u1", variation_key: "control", first_seen_at: now - 2000 },
      { user_id: "u2", variation_key: "control", first_seen_at: now - 2000 },
    ]);
    const events = await t.d1.prepare("select name, user_id, value from events").all();
    expect(events.results).toEqual([{ name: "purchase", user_id: "u1", value: 12.5 }]);
  });

  it("stores the exposure phase (0 when omitted) and keeps one first exposure per phase", async () => {
    const sdkKey = await productionSdkKey();
    const now = Date.now();
    const exposure = { experimentKey: "phased", variationKey: "control", userId: "u1", ts: now - 2000 };
    await post(sdkKey, { exposures: [exposure, { ...exposure, phase: 1, ts: now - 1000 }, { ...exposure, phase: 1, ts: now }] });
    const rows = await t.d1.prepare("select phase, first_seen_at from exposures where experiment_key = 'phased' order by phase").all();
    expect(rows.results).toEqual([
      { phase: 0, first_seen_at: now - 2000 },
      { phase: 1, first_seen_at: now - 1000 },
    ]);
    expect((await post(sdkKey, { exposures: [{ ...exposure, phase: -1 }] })).status).toBe(400);
    expect((await post(sdkKey, { exposures: [{ ...exposure, phase: 1.5 }] })).status).toBe(400);
  });

  it("drops bot traffic, rejects oversized batches and unknown keys", async () => {
    const sdkKey = await productionSdkKey();
    const exposure = { experimentKey: "bot-exp", variationKey: "control", userId: "bot", ts: Date.now() };
    const bot = await post(sdkKey, { exposures: [exposure] }, { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(bot.status).toBe(202);
    expect(await bot.json()).toEqual({ accepted: 0 });
    expect((await exposureRows()).some((r) => r.user_id === "bot")).toBe(false);

    const tooMany = await post(sdkKey, { exposures: Array.from({ length: 501 }, (_, i) => ({ ...exposure, userId: `u${i}` })) });
    expect(tooMany.status).toBe(413);
    expect((await post(sdkKey, "not json")).status).toBe(400);
    expect((await post("sdk-unknown", { exposures: [exposure] })).status).toBe(404);
  });

  it("accepts events from server-side SDKs whose runtime user agent looks like a bot", async () => {
    const sdkKey = await productionSdkKey();
    const res = await handleApiRequest(
      new Request(`${ORIGIN}/api/sdk/v1/events/${sdkKey}`, {
        method: "POST",
        headers: { "content-type": "text/plain", "user-agent": "node" },
        body: JSON.stringify({ events: [{ name: "server-purchase", userId: "srv-1", value: 10, ts: Date.now() }] }),
      }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ accepted: 1 });
  });

  it("stores a full 500-item batch across chunked statements", async () => {
    const sdkKey = await productionSdkKey();
    const now = Date.now();
    const res = await post(sdkKey, {
      exposures: Array.from({ length: 250 }, (_, i) => ({ experimentKey: "bulk", variationKey: "control", userId: `b${i}`, ts: now })),
      events: Array.from({ length: 250 }, (_, i) => ({ name: "bulk", userId: `b${i}`, value: null, ts: now })),
    });
    expect(await res.json()).toEqual({ accepted: 500 });
    const count = await t.d1.prepare("select count(*) as n from exposures where experiment_key = 'bulk'").first<{ n: number }>();
    expect(count!.n).toBe(250);
  });

  it("stores event properties and exposure dimensions as JSON; the first exposure keeps its dimensions", async () => {
    const sdkKey = await productionSdkKey();
    const now = Date.now();
    const exposure = { experimentKey: "dims", variationKey: "control", userId: "d1", ts: now - 1000 };
    const res = await post(sdkKey, {
      exposures: [{ ...exposure, dimensions: { country: "jp" } }, { ...exposure, ts: now, dimensions: { country: "us" } }],
      events: [
        { name: "props", userId: "d1", properties: { plan: "pro", seats: 3, trial: false }, ts: now },
        { name: "props", userId: "d1", ts: now },
      ],
    });
    expect(await res.json()).toEqual({ accepted: 4 });
    const dims = await t.d1.prepare("select dimensions from exposures where experiment_key = 'dims'").all();
    expect(dims.results).toEqual([{ dimensions: '{"country":"jp"}' }]);
    const props = await t.d1.prepare("select properties from events where name = 'props' order by id").all();
    expect(props.results).toEqual([{ properties: '{"plan":"pro","seats":3,"trial":false}' }, { properties: null }]);
  });

  it("rejects properties and dimensions beyond the limits or of the wrong shape", async () => {
    const sdkKey = await productionSdkKey();
    const event = (properties: unknown) => post(sdkKey, { events: [{ name: "bad", userId: "u", properties, ts: Date.now() }] });
    const exposure = (dimensions: unknown) =>
      post(sdkKey, { exposures: [{ experimentKey: "bad", variationKey: "control", userId: "u", dimensions, ts: Date.now() }] });
    const keys = (n: number, value: unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value]));

    expect((await event(keys(20, "x"))).status).toBe(202);
    expect((await event(keys(21, "x"))).status).toBe(400);
    expect((await event({ ["k".repeat(65)]: "x" })).status).toBe(400);
    expect((await event({ plan: "x".repeat(201) })).status).toBe(400);
    expect((await event({ nested: { a: 1 } })).status).toBe(400);
    expect((await event({ list: ["a"] })).status).toBe(400);
    expect((await event({ none: null })).status).toBe(400);
    expect((await exposure(keys(5, "x"))).status).toBe(202);
    expect((await exposure(keys(6, "x"))).status).toBe(400);
    expect((await exposure({ country: "x".repeat(101) })).status).toBe(400);
    expect((await exposure({ age: 30 })).status).toBe(400);
  });
});

describe("analysis RPC", () => {
  it("tests the built-in data source, serves hourly volume and 404s results of unknown experiments", async () => {
    const tested = await rpc(owner.cookie, "dataSources/test", { id: "builtin" });
    expect(tested).toMatchObject({ status: 200, json: { ok: true, bytesProcessed: null } });
    expect(tested.json.message).toMatch(/^Built-in event store: [\d,]+ events in the last 30 days$/);
    expect((await rpc(owner.cookie, "results/refresh", { experimentId: "missing" })).status).toBe(404);
    expect((await rpc(owner.cookie, "results/latest", { experimentId: "missing" })).status).toBe(404);
    const volume = await rpc(owner.cookie, "events/volume", { environmentId: "env_production" });
    expect(volume.json).toHaveLength(24);
  });
});
