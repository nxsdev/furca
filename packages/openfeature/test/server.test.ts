import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createClient, type Exposure } from "@furca/sdk";
import { OpenFeature } from "@openfeature/server-sdk";
import { FurcaServerProvider } from "../src/server.ts";
import { fakeServer, payload } from "./fixtures.ts";

beforeAll(() => {
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => OpenFeature.clearProviders());

describe("FurcaServerProvider", () => {
  test("evaluates each call's own context; maps reasons, variants and errors", async () => {
    const server = fakeServer();
    await OpenFeature.setProviderAndWait(new FurcaServerProvider({ apiHost: "https://furca.test", sdkKey: "k", fetch: server.fetch }));
    const of = OpenFeature.getClient();
    expect(await of.getBooleanDetails("pro", false, { targetingKey: "u1", plan: "pro" })).toMatchObject({ value: true, reason: "TARGETING_MATCH" });
    expect(await of.getBooleanDetails("pro", false, { targetingKey: "u2", plan: "free" })).toMatchObject({ value: false, reason: "DEFAULT" });
    expect(await of.getStringDetails("everyone", "x", { targetingKey: "u1" })).toMatchObject({ value: "b", reason: "SPLIT" });
    expect(await of.getStringDetails("everyone", "x", {})).toMatchObject({ value: "a", reason: "DEFAULT" }); // no id: rollout skipped
    const exp = await of.getStringDetails("exp", "x", { targetingKey: "u1" });
    expect(exp).toMatchObject({ reason: "SPLIT", flagMetadata: { experimentKey: "exp-key" } });
    expect(exp.variant).toBe(exp.value === "a" ? "control" : "treatment");
    expect(await of.getNumberDetails("missing", 3, {})).toMatchObject({ value: 3, reason: "ERROR", errorCode: "FLAG_NOT_FOUND" });
    expect(await of.getNumberDetails("config", 3, {})).toMatchObject({ value: 3, reason: "ERROR", errorCode: "TYPE_MISMATCH" });
    expect(await of.getObjectValue("config", {}, {})).toEqual({ theme: "dark" });
    expect(server.gets).toBe(1); // cached
  });

  test("cacheTtl: a stale payload is served while it refreshes; failures keep the last copy", async () => {
    const server = fakeServer();
    const provider = new FurcaServerProvider({ apiHost: "https://furca.test", sdkKey: "k", fetch: server.fetch, cacheTtl: 20 });
    await OpenFeature.setProviderAndWait(provider);
    const of = OpenFeature.getClient();
    server.current = { ...payload("t2"), features: { ...payload().features, limit: { defaultValue: 99, rules: [] } } };
    await Bun.sleep(30);
    expect(await of.getNumberValue("limit", 0)).toBe(10); // stale copy, refresh started
    await Bun.sleep(5);
    expect(await of.getNumberValue("limit", 0)).toBe(99);
    expect(server.gets).toBe(2);
    server.fail = true;
    await Bun.sleep(30);
    await of.getNumberValue("limit", 0);
    await Bun.sleep(5);
    expect(await of.getNumberValue("limit", 0)).toBe(99);
    expect(server.gets).toBe(3); // the failure waits a TTL before retrying
  });

  test("with a client: per-call users get exposures recorded; the client's attributes are untouched", async () => {
    const server = fakeServer();
    const exposures: Exposure[] = [];
    const client = createClient({ sdkKey: "k", apiHost: "https://furca.test", fetch: server.fetch, onExposure: (e) => exposures.push(e) });
    await OpenFeature.setProviderAndWait(new FurcaServerProvider({ client }));
    const of = OpenFeature.getClient();
    await of.getStringValue("exp", "x", { targetingKey: "a" });
    await of.getStringValue("exp", "x", { targetingKey: "b" });
    expect(exposures.map((e) => e.userId)).toEqual(["a", "b"]);
    expect(client.getAttributes()).toEqual({});
    client.destroy();
  });

  test("initialize fails when the payload cannot be loaded; defaults are served", async () => {
    const server = fakeServer();
    server.fail = true;
    await expect(OpenFeature.setProviderAndWait(new FurcaServerProvider({ apiHost: "https://furca.test", sdkKey: "k", fetch: server.fetch }))).rejects.toThrow();
    expect(await OpenFeature.getClient().getBooleanDetails("off", true, {})).toMatchObject({ value: true, errorCode: "PROVIDER_NOT_READY" });
  });
});
