/**
 * Seeds a local furca instance with demo flags, metrics, a running experiment and simulated traffic.
 *
 *   bun scripts/seed-demo.ts [baseUrl=http://localhost:5173] [setup|traffic|all=all] [users=4000]
 *
 * Signs in with DEV_OWNER_EMAIL / DEV_OWNER_PASSWORD from .env (creates the owner on a fresh instance).
 * Traffic is spread between the experiment's phase start and now (ingest accepts the last 7 days).
 * Users are bucketed with the real SDK, so assignments match what production clients would see
 */
import { evaluate, type SdkPayload } from "../packages/sdk/src/index.ts";

const base = process.argv[2] ?? "http://localhost:5173";
const mode = process.argv[3] ?? "all";
const userCount = Number(process.argv[4] ?? 4000);
const email = process.env.DEV_OWNER_EMAIL ?? "owner@furca.test";
const password = process.env.DEV_OWNER_PASSWORD ?? "furca-demo-password";

let cookie = "";

const auth = async (path: string, body: object) => {
  const res = await fetch(`${base}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(body),
  });
  if (res.ok) cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return res.ok;
};

const rpc = async <T>(path: string, input: unknown = {}): Promise<T> => {
  const res = await fetch(`${base}/api/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json()) as { json: T & { message?: string } };
  if (!res.ok) throw new Error(`${path}: ${body.json.message ?? res.status}`);
  return body.json;
};

type Env = { environment: { id: string; key: string; sdkKey: string } };
type Entity = { id: string; key: string };

const ensure = async <T extends Entity>(list: ReadonlyArray<T>, key: string, create: () => Promise<T>) =>
  list.find((x) => x.key === key) ?? (await create());

const signIn = async () => {
  if (!(await auth("sign-in/email", { email, password }))) {
    if (!(await auth("sign-up/email", { email, password, name: "Demo Owner" }))) throw new Error("Could not sign in or sign up");
  }
};

const setup = async () => {
  const envs = await rpc<Env[]>("environments/list");
  const prod = envs.find((e) => e.environment.key === "production")!.environment;
  const dev = envs.find((e) => e.environment.key === "development")?.environment;
  const flags = await rpc<Entity[]>("features/list", { includeArchived: true });

  const flag = (key: string, valueType: string, defaultValue: string, description: string, tags: string[]) =>
    ensure(flags, key, () => rpc("features/create", { key, valueType, defaultValue, description, tags }));

  const checkout = await flag("new-checkout", "boolean", "false", "One-page checkout with saved payment methods", ["checkout"]);
  const color = await flag("cta-color", "string", '"blue"', "Primary call-to-action color", ["growth"]);
  const ranking = await flag("search-ranking", "json", '{"algorithm":"bm25","boost":1}', "Search ranking parameters", ["search"]);
  const cart = await flag("max-cart-items", "number", "20", "Maximum items allowed in the cart", []);

  for (const f of [checkout, color, ranking, cart]) {
    for (const env of [prod, dev]) {
      if (env !== undefined) await rpc("features/setEnabled", { id: f.id, environmentId: env.id, enabled: true });
    }
  }
  const uuid = () => crypto.randomUUID();
  await rpc("features/saveRules", {
    id: color.id,
    environmentId: prod.id,
    rules: [
      { _tag: "force", id: uuid(), description: "Brand test in Japan", enabled: true, conditions: [{ attribute: "country", operator: "in", values: ["JP"] }], value: '"vermilion"' },
    ],
  });
  await rpc("features/saveRules", {
    id: cart.id,
    environmentId: prod.id,
    rules: [
      { _tag: "force", id: uuid(), description: "Internal staff", enabled: true, conditions: [{ attribute: "email", operator: "ends_with", values: ["@furca.dev"] }], value: "100" },
      { _tag: "rollout", id: uuid(), description: "Gradual increase", enabled: true, conditions: [], value: "50", coverage: 0.3, hashAttribute: "id", seed: uuid() },
    ],
  });

  const metrics = await rpc<Entity[]>("metrics/list", { includeArchived: true });
  const metric = (key: string, input: object) => ensure(metrics, key, () => rpc("metrics/create", { key, ...input }));
  const common = { description: "", dataSourceId: "builtin", inverse: false, windowHours: 72, delayHours: 0, capping: { type: "none" } };
  const purchase = await metric("purchase-conversion", {
    ...common,
    name: "Purchase conversion",
    type: "proportion",
    definition: { _tag: "event", numerator: { event: "purchase", aggregation: "count" }, denominator: null },
  });
  const revenue = await metric("revenue-per-user", {
    ...common,
    name: "Revenue per user",
    type: "mean",
    capping: { type: "percentile", value: 0.99 },
    definition: { _tag: "event", numerator: { event: "purchase", aggregation: "sum" }, denominator: null },
  });
  const addToCart = await metric("add-to-cart", {
    ...common,
    name: "Add to cart",
    type: "proportion",
    definition: { _tag: "event", numerator: { event: "add_to_cart", aggregation: "count" }, denominator: null },
  });
  const latency = await metric("page-load-ms", {
    ...common,
    name: "Page load time",
    description: "Average page load (ms) across page views",
    type: "ratio",
    inverse: true,
    windowHours: null,
    definition: { _tag: "event", numerator: { event: "page_view", aggregation: "sum" }, denominator: { event: "page_view", aggregation: "count" } },
  });

  const experiments = await rpc<Array<Entity & { status: string }>>("experiments/list", { includeArchived: true });
  const experiment = await ensure(experiments, "checkout-redesign", () =>
    rpc("experiments/create", {
      key: "checkout-redesign",
      name: "Checkout redesign",
      hypothesis: "If we collapse checkout into one page with saved payment methods, then more visitors will complete a purchase because there are fewer steps to abandon.",
      featureId: checkout.id,
      environmentIds: [prod.id],
      analysisEnvironmentId: prod.id,
      hashAttribute: "id",
      variations: [
        { key: "control", name: "Control", value: "false" },
        { key: "one-page", name: "One-page checkout", value: "true" },
      ],
      coverage: 1,
      weights: [0.5, 0.5],
      conditions: [],
      dataSourceId: "builtin",
      primaryMetricId: purchase.id,
      secondaryMetricIds: [revenue.id, addToCart.id],
      guardrailMetricIds: [latency.id],
      stats: { engine: "frequentist", sequential: true, sequentialTuning: 8000, alpha: 0.05, cuped: true, correction: "holm" },
      plan: { mde: 0.15, sampleSizePerVariation: 4000, dailyTraffic: 1200 },
    }),
  );
  if (experiment.status === "draft") await rpc("experiments/start", { id: experiment.id });
  console.log(`setup done · experiment ${experiment.id} · production SDK key ${prod.sdkKey}`);
};

/** Box–Muller normal */
const normal = (mean: number, sd: number) =>
  mean + sd * Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

const traffic = async (users = userCount) => {
  // A fresh id prefix per run, so repeated runs add new users instead of duplicating events
  const run = crypto.randomUUID().slice(0, 6);
  const envs = await rpc<Env[]>("environments/list");
  const prod = envs.find((e) => e.environment.key === "production")!.environment;
  const experiments = await rpc<Array<Entity & { phases: Array<{ startedAt: string }> }>>("experiments/list", { includeArchived: false });
  const experiment = experiments.find((x) => x.key === "checkout-redesign");
  if (experiment === undefined) throw new Error("Run setup first");
  const payload = (await (await fetch(`${base}/api/sdk/v1/payload/${prod.sdkKey}`)).json()) as SdkPayload;
  const phaseRule = payload.features["new-checkout"]?.rules.find((r) => r.type === "experiment");
  const phase = phaseRule?.type === "experiment" ? phaseRule.phase : 0;

  const now = Date.now();
  const start = Math.max(new Date(experiment.phases.at(-1)!.startedAt).getTime(), now - 6 * 86_400_000);
  const items: { exposures: unknown[]; events: unknown[] } = { exposures: [], events: [] };
  const at = (t: number) => Math.min(now - 1000, Math.round(t));
  const countries = ["US", "JP", "DE", "GB", "BR"];

  for (let i = 0; i < users; i++) {
    const id = `demo-${run}-${i}`;
    const attributes = { id, country: countries[i % countries.length] };
    const result = evaluate(payload, "new-checkout", attributes);
    if (result.experiment === null) continue;
    const treated = result.experiment.variationKey !== "control";
    // More users arrive later in the window, like a ramp-up
    const exposedAt = start + Math.sqrt(Math.random()) * (now - start);
    items.exposures.push({ experimentKey: result.experiment.key, variationKey: result.experiment.variationKey, phase, userId: id, ts: at(exposedAt) });

    const after = () => at(exposedAt + Math.random() * Math.min(48 * 3600_000, now - exposedAt));
    // Pre-exposure purchases give CUPED something to work with
    const loyal = Math.random() < 0.2;
    if (loyal && exposedAt - 86_400_000 > now - 6.5 * 86_400_000) items.events.push({ name: "purchase", userId: id, value: 60, ts: at(exposedAt - 86_400_000) });

    if (Math.random() < (treated ? 0.33 : 0.3) + (loyal ? 0.1 : 0)) items.events.push({ name: "add_to_cart", userId: id, value: null, ts: after() });
    if (Math.random() < (treated ? 0.125 : 0.1) + (loyal ? 0.08 : 0)) {
      const value = Math.max(5, Math.exp(normal(3.7, 0.6)) * (Math.random() < 0.003 ? 40 : 1));
      items.events.push({ name: "purchase", userId: id, value: Math.round(value * 100) / 100, ts: after() });
    }
    const views = 1 + Math.floor(Math.random() * 4);
    for (let v = 0; v < views; v++) {
      items.events.push({ name: "page_view", userId: id, value: Math.round(normal(treated ? 820 : 800, 160)), ts: after() });
    }
  }

  const all = [...items.exposures.map((e) => ["exposures", e] as const), ...items.events.map((e) => ["events", e] as const)];
  let sent = 0;
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const body = {
      exposures: chunk.filter(([k]) => k === "exposures").map(([, e]) => e),
      events: chunk.filter(([k]) => k === "events").map(([, e]) => e),
    };
    const res = await fetch(`${base}/api/sdk/v1/events/${prod.sdkKey}`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
    sent += ((await res.json()) as { accepted: number }).accepted;
  }
  console.log(`traffic sent · ${items.exposures.length} exposures · ${sent} items accepted`);
  const snapshot = await rpc<{ status: string; error: string | null }>("results/refresh", { experimentId: experiment.id });
  console.log(`results refreshed · ${snapshot.status}${snapshot.error ? ` · ${snapshot.error}` : ""}`);
};

await signIn();
if (mode === "setup" || mode === "all") await setup();
if (mode === "traffic" || mode === "all") await traffic();
