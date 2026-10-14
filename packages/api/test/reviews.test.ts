import { afterAll, describe, expect, it } from "bun:test";
import { makeTestD1 } from "@furca/database/testing/TestDatabase";
import type { FurcaEnv } from "../src/Runtime/Env";
import { handleApiRequest } from "../src/Runtime/WorkerEntry";

// Own database: the owner is the only admin until the last test
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

const signUp = async (email: string, token?: string) => {
  const res = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { "x-furca-invitation": token }) },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
  });
  return { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
};

const rpc = async (who: { cookie: string }, path: string, input?: unknown) => {
  const res = await request(`/api/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: who.cookie },
    body: JSON.stringify({ json: input }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : (JSON.parse(text) as { json: any }).json };
};

const owner = await signUp("owner@example.com");
const join = async (email: string, role: "admin" | "editor") => {
  const invitation = await rpc(owner, "members/invite", { email, role });
  return signUp(email, (invitation.json.url as string).split("/").at(-1)!);
};
const editor = await join("editor@example.com", "editor");

const PROD = "env_production";
const DEV = "env_development";
await rpc(owner, "environments/setRequireApproval", { id: PROD, requireApproval: true });
const metric = await rpc(owner, "metrics/create", {
  key: "purchase",
  name: "Purchase",
  description: "",
  type: "proportion",
  dataSourceId: "builtin",
  definition: { _tag: "event", numerator: { event: "purchase", aggregation: "count", filters: [] }, denominator: null },
  inverse: false,
  windowHours: null,
  delayHours: 0,
  capping: { type: "none" },
});

const newFlag = async (key: string) =>
  (await rpc(editor, "features/create", { key, description: "", valueType: "string", defaultValue: '"control"', tags: [] })).json.id as string;

const newExperiment = async (featureId: string, key: string, environmentId = PROD) => {
  const res = await rpc(editor, "experiments/create", {
    key,
    name: "Checkout redesign",
    hypothesis: "",
    featureId,
    environmentIds: [environmentId],
    analysisEnvironmentId: environmentId,
    hashAttribute: "id",
    variations: [
      { key: "control", name: "Control", value: '"control"' },
      { key: "treatment", name: "Treatment", value: '"blue"' },
    ],
    coverage: 1,
    weights: [0.5, 0.5],
    conditions: [],
    dataSourceId: "builtin",
    primaryMetricId: metric.json.id,
    secondaryMetricIds: [],
    guardrailMetricIds: [],
    stats: { engine: "frequentist", sequential: true, sequentialTuning: 5000, alpha: 0.05, cuped: true, correction: "holm" },
    plan: { mde: 0.05, sampleSizePerVariation: null, dailyTraffic: null },
    dimensions: [],
    namespace: null,
  });
  expect(res.status).toBe(200);
  return res.json.id as string;
};

const open = (who: { cookie: string }, featureId: string, change: unknown, comment = "") =>
  rpc(who, "changeRequests/create", { featureId, environmentId: PROD, change, comment });

/** Opens a request as the editor and has the owner approve it */
const reviewed = async (featureId: string, change: unknown) => {
  const created = await open(editor, featureId, change);
  expect(created.status).toBe(200);
  const approved = await rpc(owner, "changeRequests/approve", { id: created.json.id, comment: "" });
  expect(approved.status).toBe(200);
  return approved.json;
};

const prodRules = async (featureId: string) =>
  (await rpc(editor, "features/get", { id: featureId })).json.environments.find((e: { environmentId: string }) => e.environmentId === PROD).rules;

describe("experiments in an environment that requires review", () => {
  it("refuses a direct start, traffic change and stop, and starts once a start request is approved", async () => {
    const flag = await newFlag("guarded-experiment");
    const id = await newExperiment(flag, "guarded-experiment");
    for (const who of [editor, owner]) {
      const start = await rpc(who, "experiments/start", { id });
      expect([start.status, start.json.message]).toEqual([403, "Production requires a review"]);
    }
    // Nothing to stop yet: the request is refused when it is opened, not at approval
    const early = await open(editor, flag, { type: "experiment.stop", experimentId: id, outcome: "rollback", variationKey: null, reason: "" });
    expect([early.status, early.json.message]).toEqual([400, "Only running experiments can be stopped"]);

    await reviewed(flag, { type: "experiment.start", experimentId: id });
    expect((await rpc(editor, "experiments/get", { id })).json.status).toBe("running");

    const traffic = await rpc(editor, "experiments/updateTraffic", { id, coverage: 0.5, weights: [0.5, 0.5], conditions: [], reason: "" });
    expect(traffic.status).toBe(403);
    const stop = await rpc(owner, "experiments/stop", { id, outcome: "rollback", variationKey: null, reason: "" });
    expect(stop.status).toBe(403);
    expect((await rpc(editor, "experiments/get", { id })).json.status).toBe("running");
  });

  it("applies an approved stop that ships a variation: force rule, payload, audit and the author's decision", async () => {
    const flag = await newFlag("ship-reviewed");
    const id = await newExperiment(flag, "ship-reviewed");
    await reviewed(flag, { type: "toggle", enabled: true });
    await reviewed(flag, { type: "experiment.start", experimentId: id });
    const approved = await reviewed(flag, { type: "experiment.stop", experimentId: id, outcome: "ship", variationKey: "treatment", reason: "Won" });
    expect(approved).toMatchObject({ status: "approved", reviewerEmail: "owner@example.com" });

    const experiment = (await rpc(editor, "experiments/get", { id })).json;
    expect(experiment).toMatchObject({ status: "stopped", decision: { outcome: "ship", variationKey: "treatment", decidedBy: "editor@example.com" } });
    expect(await prodRules(flag)).toMatchObject([{ _tag: "force", conditions: [], value: '"blue"' }]);
    const sdkKey = (await t.d1.prepare("select sdk_key from environments where id = ?").bind(PROD).first<{ sdk_key: string }>())!.sdk_key;
    const payload = JSON.parse(kv.get(`payload:${sdkKey}`)!) as { features: Record<string, { rules: unknown }> };
    expect(payload.features["ship-reviewed"]!.rules).toEqual([{ type: "force", conditions: [], value: "blue" }]);

    const audit = await rpc(owner, "audit/list", { entityType: "experiment", entityId: id, before: null, limit: 10 });
    expect(audit.json.map((a: { action: string; actorEmail: string }) => [a.action, a.actorEmail])).toEqual([
      ["stopped", "owner@example.com"],
      ["started", "owner@example.com"],
      ["created", "editor@example.com"],
    ]);
    const flagAudit = await rpc(owner, "audit/list", { entityType: "feature", entityId: flag, before: null, limit: 1 });
    expect(flagAudit.json[0].action).toBe("review.approved");
  });

  it("refuses a second open request for the same experiment until the first is closed", async () => {
    const flag = await newFlag("one-pending");
    const id = await newExperiment(flag, "one-pending");
    const first = await open(editor, flag, { type: "experiment.start", experimentId: id });
    expect(first.status).toBe(200);
    const second = await open(owner, flag, { type: "experiment.start", experimentId: id });
    expect([second.status, second.json.message]).toEqual([409, "This experiment already has a pending review request"]);
    await rpc(editor, "changeRequests/cancel", { id: first.json.id });
    expect((await open(owner, flag, { type: "experiment.start", experimentId: id })).status).toBe(200);
  });

  it("refuses to approve a request whose experiment changed since it was opened", async () => {
    const flag = await newFlag("stale-experiment");
    const id = await newExperiment(flag, "stale-experiment");
    await reviewed(flag, { type: "experiment.start", experimentId: id });
    const traffic = await open(editor, flag, { type: "experiment.traffic", experimentId: id, coverage: 0.5, weights: [0.5, 0.5], conditions: [], reason: "" });
    // Renaming needs no review, but the reviewer approved a request against the earlier experiment
    const experiment = (await rpc(editor, "experiments/get", { id })).json;
    expect((await rpc(editor, "experiments/update", { ...experiment, name: "Checkout redesign v2" })).status).toBe(200);
    const stale = await rpc(owner, "changeRequests/approve", { id: traffic.json.id, comment: "" });
    expect([stale.status, stale.json.message]).toEqual([409, "The experiment changed since this request; open a new one"]);
    expect((await rpc(editor, "experiments/get", { id })).json.coverage).toBe(1);
  });

  it("refuses to start an experiment whose rule sits below a rule that serves everyone", async () => {
    const flag = await newFlag("shadowed-experiment");
    const id = await newExperiment(flag, "shadowed-experiment", DEV);
    const dev = (await rpc(editor, "features/get", { id: flag })).json.environments.find((e: { environmentId: string }) => e.environmentId === DEV);
    const everyone = { _tag: "force", id: "all", description: "Everyone", enabled: true, conditions: [], value: '"on"' };
    expect((await rpc(editor, "features/saveRules", { id: flag, environmentId: DEV, rules: [everyone, ...dev.rules] })).status).toBe(200);
    const start = await rpc(editor, "experiments/start", { id });
    expect(start.status).toBe(400);
    expect(start.json.message).toStartWith("In Development, rule 1 serves everyone before the experiment's rule");
    // Disabled, the rule no longer blocks
    await rpc(editor, "features/saveRules", { id: flag, environmentId: DEV, rules: [{ ...everyone, enabled: false }, ...dev.rules] });
    expect((await rpc(editor, "experiments/start", { id })).status).toBe(200);
  });
});

describe("self-approval", () => {
  it("lets the only admin approve their own request with a reason, and refuses it once another admin exists", async () => {
    const flag = await newFlag("solo-admin");
    const mine = await open(owner, flag, { type: "toggle", enabled: true });
    const silent = await rpc(owner, "changeRequests/approve", { id: mine.json.id, comment: " " });
    expect(silent.status).toBe(400);
    const approved = await rpc(owner, "changeRequests/approve", { id: mine.json.id, comment: "Hotfix; nobody else can review" });
    expect(approved.json).toMatchObject({ status: "approved", reviewerEmail: "owner@example.com", authorEmail: "owner@example.com" });
    const audit = await rpc(owner, "audit/list", { entityType: "feature", entityId: flag, before: null, limit: 10 });
    expect(audit.json.map((a: { action: string }) => a.action)).toContain("review.selfApproved");

    await join("second-admin@example.com", "admin");
    const again = await open(owner, flag, { type: "toggle", enabled: false });
    const refused = await rpc(owner, "changeRequests/approve", { id: again.json.id, comment: "Hotfix" });
    expect([refused.status, refused.json.message]).toEqual([403, "You can't approve your own request. Ask another admin"]);
  });
});
