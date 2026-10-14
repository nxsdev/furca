import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createClient, type Exposure } from "@furca/sdk";
import { ClientProviderStatus, OpenFeature, ProviderEvents } from "@openfeature/web-sdk";
import { FurcaWebProvider } from "../src/web.ts";
import { fakeServer, payload } from "./fixtures.ts";

beforeAll(() => {
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => OpenFeature.clearProviders());

function setup() {
  const server = fakeServer();
  const exposures: Exposure[] = [];
  const client = createClient({ sdkKey: "k", apiHost: "https://furca.test", fetch: server.fetch, onExposure: (e) => exposures.push(e) });
  return { server, client, exposures, of: OpenFeature.getClient() };
}

describe("FurcaWebProvider", () => {
  test("maps furca results to OpenFeature reasons, variants and errors", async () => {
    const { client, of } = setup();
    await OpenFeature.setContext({ targetingKey: "u1" });
    await OpenFeature.setProviderAndWait(new FurcaWebProvider(client));
    expect(of.getBooleanDetails("off", true)).toMatchObject({ value: false, reason: "DEFAULT" });
    expect(of.getStringDetails("everyone", "x")).toMatchObject({ value: "b", reason: "SPLIT" });
    expect(of.getNumberDetails("limit", 0)).toMatchObject({ value: 10, reason: "DEFAULT" });
    expect(of.getObjectDetails("config", {})).toMatchObject({ value: { theme: "dark" }, reason: "DEFAULT" });
    const exp = of.getStringDetails("exp", "x");
    expect(exp).toMatchObject({ reason: "SPLIT", flagMetadata: { experimentKey: "exp-key" } });
    expect(exp.variant).toBe(exp.value === "a" ? "control" : "treatment");
    expect(of.getBooleanDetails("missing", true)).toMatchObject({ value: true, reason: "ERROR", errorCode: "FLAG_NOT_FOUND" });
    expect(of.getStringDetails("limit", "x")).toMatchObject({ value: "x", reason: "ERROR", errorCode: "TYPE_MISMATCH" });
    expect(of.getObjectDetails("off", { a: 1 })).toMatchObject({ value: { a: 1 }, errorCode: "TYPE_MISMATCH" });
  });

  test("context changes become client attributes (targetingKey → id) and re-evaluate", async () => {
    const { client, exposures, of } = setup();
    await OpenFeature.setProviderAndWait(new FurcaWebProvider(client), { targetingKey: "u1", plan: "free" });
    expect(client.getAttributes()).toEqual({ id: "u1", plan: "free" });
    expect(of.getBooleanValue("pro", false)).toBe(false);
    await OpenFeature.setContext({ targetingKey: "u2", plan: "pro" });
    expect(client.getAttributes()).toEqual({ id: "u2", plan: "pro" });
    expect(of.getBooleanDetails("pro", false)).toMatchObject({ value: true, reason: "TARGETING_MATCH" });
    of.getStringValue("exp", "x");
    expect(exposures.map((e) => e.userId)).toEqual(["u2"]);
  });

  test("emits ConfigurationChanged when a refresh brings a new payload, not on context changes", async () => {
    const { server, client } = setup();
    let changes = 0;
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, () => changes++);
    await OpenFeature.setProviderAndWait(new FurcaWebProvider(client));
    await OpenFeature.setContext({ targetingKey: "u9" });
    await client.refresh(); // same payload
    expect(changes).toBe(0);
    server.current = payload("t2");
    await client.refresh();
    expect(changes).toBe(1);
  });

  test("a failed first load puts the provider in ERROR until a refresh succeeds", async () => {
    const { server, client, of } = setup();
    server.fail = true;
    await OpenFeature.setProviderAndWait(new FurcaWebProvider(client)).catch(() => {});
    expect(OpenFeature.getClient().providerStatus).toBe(ClientProviderStatus.ERROR);
    expect(of.getBooleanDetails("off", true)).toMatchObject({ value: true, errorCode: "PROVIDER_NOT_READY" });
    server.fail = false;
    await client.refresh();
    expect(OpenFeature.getClient().providerStatus).toBe(ClientProviderStatus.READY);
    expect(of.getBooleanValue("off", true)).toBe(false);
  });
});
