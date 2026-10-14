import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { makeTestD1 } from "@furca/database/testing/TestDatabase";
import { signWebhookBody, slackText } from "@furca/persistence/webhooks";
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

/** Background work (webhook deliveries) is collected so a test can wait for it */
const background: Array<Promise<unknown>> = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
const settle = () => Promise.all(background.splice(0));

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
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

const rpc = async (path: string, input?: unknown) => {
  const res = await request(`/api/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ json: input }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : (JSON.parse(text) as { json: any }).json };
};

/** REST call with an API key (and the session cookie, which /api/v1 must ignore) */
const rest = async (secret: string | null, path: string, input?: unknown) => {
  const res = await request(`/api/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
    body: JSON.stringify(input ?? {}),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : (JSON.parse(text) as any) };
};

const cookie = await signUp("owner@example.com");

const createKey = async (name: string, role: "admin" | "readonly") => {
  const res = await rpc("apiKeys/create", { name, role });
  expect(res.status).toBe(200);
  return res.json as { apiKey: { id: string; prefix: string }; secret: string };
};

const flagInput = (key: string) => ({ key, description: "", valueType: "boolean", defaultValue: "false", tags: [] });

describe("API keys", () => {
  it("authenticates REST calls with a bearer key and records the key as the audit actor", async () => {
    const { apiKey, secret } = await createKey("CI deploys", "admin");
    expect(secret).toMatch(/^furca_[A-Za-z0-9_-]{43}$/);
    expect(apiKey.prefix).toBe(secret.slice(0, 12));
    expect(JSON.stringify((await rpc("apiKeys/list")).json)).not.toContain(secret);

    const created = await rest(secret, "features/create", flagInput("from-ci"));
    expect(created.status).toBe(200);
    const audit = await rest(secret, "audit/list", { entityType: "feature", entityId: created.json.id, before: null, limit: 10 });
    expect(audit.json.map((a: { actorId: string; actorEmail: string }) => [a.actorId, a.actorEmail])).toEqual([
      [`apikey:${apiKey.id}`, "api-key:CI deploys"],
    ]);
    await settle();
    const [listed] = (await rpc("apiKeys/list")).json as Array<{ id: string; lastUsedAt: string | null }>;
    expect(listed?.id).toBe(apiKey.id);
    expect(listed?.lastUsedAt).not.toBeNull();
  });

  it("ignores the session cookie on /api/v1, so a browser session cannot call the REST API", async () => {
    expect((await rest(null, "features/list", { includeArchived: false })).status).toBe(401);
  });

  it("rejects a revoked key and unknown keys", async () => {
    const { apiKey, secret } = await createKey("Old script", "admin");
    expect((await rest(secret, "features/list", { includeArchived: false })).status).toBe(200);
    expect((await rpc("apiKeys/revoke", { id: apiKey.id })).json.revokedAt).not.toBeNull();
    expect((await rest(secret, "features/list", { includeArchived: false })).status).toBe(401);
    expect((await rest("furca_not-a-real-key", "features/list", { includeArchived: false })).status).toBe(401);
  });

  it("lets a readonly key read but not write", async () => {
    const { secret } = await createKey("Dashboard", "readonly");
    expect((await rest(secret, "features/list", { includeArchived: false })).status).toBe(200);
    const write = await rest(secret, "features/create", flagInput("readonly-write"));
    expect(write.status).toBe(403);
    expect(write.json.message).toBe("This API key is read-only");
    expect((await rest(secret, "apiKeys/create", { name: "escalate", role: "admin" })).status).toBe(403);
  });
});

describe("OpenAPI", () => {
  it("serves an OpenAPI 3.1 document of the REST surface with bearer auth", async () => {
    const res = await request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
      components: { securitySchemes: Record<string, { scheme: string }> };
    };
    expect(doc.openapi).toStartWith("3.1");
    expect(doc.info.title).toBe("furca API");
    expect(doc.servers).toEqual([{ url: `${ORIGIN}/api/v1` }]);
    expect(doc.paths["/features/create"]?.post?.requestBody).toBeDefined();
    expect(doc.components.securitySchemes.apiKey?.scheme).toBe("bearer");
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/session") || p.startsWith("/public"))).toBe(false);
  });
});

describe("webhooks", () => {
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; headers: Headers; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://hooks.test/")) return realFetch(input, init);
    sent.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response("ok", { status: url.endsWith("/broken") ? 500 : 200 });
  }) as typeof fetch;
  afterAll(() => void (globalThis.fetch = realFetch));
  afterEach(() => void sent.splice(0));

  const createHook = async (name: string, path: string, format: "json" | "slack", events: ReadonlyArray<string>) => {
    const res = await rpc("webhooks/create", { name, url: `https://hooks.test/${path}`, format, events });
    expect(res.status).toBe(200);
    return res.json as { webhook: { id: string }; secret: string };
  };

  it("delivers only to enabled webhooks subscribed to the event, signed with the webhook's secret", async () => {
    const subscribed = await createHook("Deploy bot", "flags", "json", ["flag.updated"]);
    const disabled = await createHook("Paused", "paused", "json", ["flag.updated"]);
    await rpc("webhooks/update", {
      id: disabled.webhook.id,
      name: "Paused",
      url: "https://hooks.test/paused",
      format: "json",
      events: ["flag.updated"],
      enabled: false,
    });
    await createHook("Experiments only", "experiments", "json", ["experiment.started"]);

    const flag = await rpc("features/create", flagInput("hooked-flag"));
    await settle();

    expect(sent.map((s) => s.url)).toEqual(["https://hooks.test/flags"]);
    const [delivery] = sent;
    expect(delivery!.headers.get("furca-event")).toBe("flag.updated");
    expect(delivery!.headers.get("furca-signature")).toBe(await signWebhookBody(subscribed.secret, delivery!.body));
    expect(await signWebhookBody("wrong-secret", delivery!.body)).not.toBe(delivery!.headers.get("furca-signature"));
    const body = JSON.parse(delivery!.body);
    expect(body).toMatchObject({
      id: delivery!.headers.get("furca-delivery"),
      event: "flag.updated",
      data: { flag: { id: flag.json.id, key: "hooked-flag" }, action: "created", actor: "owner@example.com" },
    });

    const [hook] = ((await rpc("webhooks/list")).json as Array<{ id: string; lastStatus: number | null }>).filter(
      (w) => w.id === subscribed.webhook.id,
    );
    expect(hook?.lastStatus).toBe(200);
  });

  it("sends Slack webhooks a { text } message", async () => {
    await createHook("Slack #releases", "slack", "slack", ["payload.updated"]);
    const flag = await rpc("features/create", flagInput("slack-flag"));
    await rpc("features/setEnabled", { id: flag.json.id, environmentId: "env_production", enabled: true });
    await settle();
    const slack = sent.filter((s) => s.url === "https://hooks.test/slack");
    expect(slack.length).toBe(1);
    expect(JSON.parse(slack[0]!.body)).toEqual({ text: "SDK payload updated in Production, Development" });
  });

  it("send test pings the endpoint now and records a failure", async () => {
    const broken = await createHook("Broken", "broken", "json", ["flag.updated"]);
    const result = await rpc("webhooks/test", { id: broken.webhook.id });
    expect(result.json).toEqual({ status: 500, error: "HTTP 500" });
    expect(sent.map((s) => s.headers.get("furca-event"))).toEqual(["ping"]);
    const hook = ((await rpc("webhooks/list")).json as Array<{ id: string; lastError: string | null }>).find((w) => w.id === broken.webhook.id);
    expect(hook?.lastError).toBe("HTTP 500");
  });

  it("formats experiment events as one Slack line with escaped names", () => {
    const names = new Map([["env_production", "Production"]]);
    const data = {
      experiment: { id: "e1", key: "checkout", name: "Checkout <redesign>", status: "running" },
      environmentIds: ["env_production"],
      reason: "Experiment started",
      outcome: null,
      variationKey: null,
      actor: "owner@example.com",
    };
    const name = (id: string) => names.get(id) ?? id;
    expect(slackText({ event: "experiment.started", data }, name)).toBe(
      "Experiment *Checkout &lt;redesign&gt;* started in Production by owner@example.com",
    );
    expect(
      slackText({ event: "experiment.stopped", data: { ...data, outcome: "ship", variationKey: "treatment", reason: "Clear win" } }, name),
    ).toBe("Experiment *Checkout &lt;redesign&gt;* shipped `treatment` by owner@example.com: Clear win");
  });

  it("rejects invalid webhook input", async () => {
    const bad = await rpc("webhooks/create", { name: "x", url: "ftp://example.com", format: "json", events: ["flag.updated"] });
    expect(bad.status).toBe(400);
    expect((await rpc("webhooks/create", { name: "x", url: "https://hooks.test/x", format: "json", events: [] })).status).toBe(400);
  });
});
