# @furca/sdk

TypeScript SDK for [furca](https://github.com/nxsdev/furca) feature flags and A/B tests.

- Local evaluation: the SDK downloads one JSON payload and evaluates every flag in memory, synchronously.
- Zero dependencies. Runs in browsers, Cloudflare Workers, Node ≥ 20, Bun and Deno.
- Bucketing is byte-compatible with GrowthBook (FNV-1a 32 hash v2), so users keep their buckets when you migrate.

```sh
npm install @furca/sdk
```

## Browser

```ts
import { createClient } from "@furca/sdk";

const furca = createClient({
  apiHost: "https://furca.example.com",
  sdkKey: "sdk_prod_xxx",
  attributes: { id: user.id, country: "jp", appVersion: "2.3.0" },
  refreshInterval: 60_000, // optional polling, ms (default 0 = never)
});

await furca.ready(); // never rejects; on failure every flag returns your fallback

if (furca.isOn("new-checkout")) showNewCheckout();
const color = furca.getValue("button-color", "blue");

furca.track("purchase", 4980, { plan: "pro", coupon: true }); // needs an `id` attribute
```

`track(name, value?, properties?)`: `properties` are flat (string, number or boolean values) for metric filters, at most 20 keys of up to 64 characters; strings are cut to 200 characters. Anything else is dropped with a one-time console warning.

Events and exposures are batched: they are sent every `flushInterval` ms (default 2000) or when `maxBatchSize` (default 100) items are queued. When the page is hidden or unloaded the queue goes out with `navigator.sendBeacon`. Network errors are logged once and never thrown.

## Cloudflare Workers

Workers end when the response is returned, so hand the flush to `ctx.waitUntil`. Fetch the payload once per isolate and reuse it across requests:

```ts
import { createClient, fetchPayload, type SdkPayload } from "@furca/sdk";

let cache: { payload: SdkPayload; at: number } | undefined;

async function getPayload(env: Env): Promise<SdkPayload | undefined> {
  if (!cache || Date.now() - cache.at > 30_000) {
    try {
      cache = { payload: await fetchPayload({ apiHost: env.FURCA_HOST, sdkKey: env.FURCA_SDK_KEY }), at: Date.now() };
    } catch (e) {
      console.warn("furca payload refresh failed, keeping last copy", e); // fetchPayload throws, the client never does
    }
  }
  return cache?.payload;
}

export default {
  async fetch(request, env, ctx) {
    const furca = createClient({
      apiHost: env.FURCA_HOST,
      sdkKey: env.FURCA_SDK_KEY,
      payload: await getPayload(env), // bootstrapped: no fetch, no ready() needed
      attributes: { id: request.headers.get("x-user-id"), country: request.cf?.country },
    });

    const body = furca.isOn("new-pricing") ? renderNewPricing() : renderPricing();

    ctx.waitUntil(furca.flush()); // sends exposures/events after the response
    return new Response(body);
  },
} satisfies ExportedHandler<Env>;
```

Calling furca through a service binding? Pass `fetch: (url, init) => env.FURCA.fetch(url, init)`.

## React and OpenFeature

- [`@furca/react`](../react/README.md): `<FurcaProvider>`, `useFeatureValue`, `useFeatureIsOn`, `useEvaluation`, `<IfFeatureEnabled>`. Re-renders on payload refreshes and attribute changes, SSR-safe.
- [`@furca/openfeature`](../openfeature/README.md): OpenFeature providers for `@openfeature/web-sdk` and `@openfeature/server-sdk`.

`subscribe(listener)` fires when a refresh brings a new payload and when `setAttributes` / `updateAttributes` change the attributes (once a payload is loaded), so a UI binding only needs this one signal.

## Servers: one client, many users

`evaluate(key, attributes)` evaluates for the given user without touching the client's own attributes, and records that user's exposure. A long-lived Node / Bun server can keep one client (with `refreshInterval`) for all requests:

```ts
const furca = createClient({ apiHost, sdkKey, refreshInterval: 30_000 });
await furca.ready();

app.get("/pricing", (req, res) => {
  const { value } = furca.evaluate("new-pricing", { id: req.user.id, country: req.country });
  res.send(value === true ? renderNewPricing() : renderPricing());
});
```

## Sending exposures to GA4 / Segment

`onExposure` is called once per experiment phase, variation and user per client, when the user is first evaluated into an experiment. It runs even with `trackExposures: false`.

When the experiment lists breakdown `dimensions` (e.g. `country`, `plan`), each exposure carries those attributes' values at exposure time (`String()`, up to 100 characters, missing ones left out), so results can be split by them.

```ts
const furca = createClient({
  apiHost: "https://furca.example.com",
  sdkKey: "sdk_prod_xxx",
  attributes: { id: user.id },
  onExposure: (e) => {
    gtag("event", "experiment_viewed", { experiment_id: e.experimentKey, variation_id: e.variationKey });
    // analytics.track("Experiment Viewed", { experimentId: e.experimentKey, variationId: e.variationKey });
  },
});
```

## API

```ts
createClient(options: ClientOptions): FurcaClient
fetchPayload({ apiHost, sdkKey, fetch? }): Promise<SdkPayload>   // throws on failure

// Pure helpers (server-side evaluation, admin "test a user" simulator)
evaluate(payload: SdkPayload | null | undefined, key: string, attributes: Attributes): Evaluation
evaluateConditions(conditions: PayloadCondition[], attributes: Attributes, savedGroups?: SdkPayload["savedGroups"]): boolean
hash(seed: string, value: string, version: 1 | 2 = 2): number    // [0, 1), GrowthBook hash v2 (v1: namespaces)
inNamespace(hashValue: string, namespace: [key, start, end]): boolean  // GrowthBook inNamespace
getBucketRanges(numVariations: number, coverage?: number, weights?: number[]): [number, number][]
chooseVariation(n: number, ranges: [number, number][]): number
```

| `ClientOptions` | Default | |
| --- | --- | --- |
| `sdkKey` | required | |
| `apiHost` | — | Required unless `payload` is given |
| `attributes` | `{}` | |
| `payload` | — | Bootstrapped payload. `ready()` then resolves without fetching |
| `refreshInterval` | `0` | Payload polling, ms. `0` = never |
| `flushInterval` | `2000` | Max delay before queued events are sent, ms. `0` = only on size / `flush()` |
| `maxBatchSize` | `100` | |
| `trackExposures` | `true` | Send exposures to furca |
| `onExposure` | — | `(exposure) => void` |
| `fetch` | `globalThis.fetch` | Called unbound |

`FurcaClient`: `ready()`, `isOn(key)`, `getValue(key, fallback)`, `evaluate(key, attributes?)`, `setAttributes(attrs)`, `updateAttributes(partial)`, `getAttributes()`, `getPayload()`, `track(name, value?, properties?)`, `flush()`, `refresh()`, `subscribe(listener) → unsubscribe`, `destroy()`.

## Evaluation rules

- A feature missing from the payload (unknown, or disabled in this environment) evaluates to `{ value: null, source: "unknown" }`, so `getValue` returns your fallback.
- Rules run top to bottom and the first one that applies wins. If none applies you get the feature's `defaultValue` (`source: "default"`).
- Conditions in a rule are AND-ed. Attribute values are compared as `String(value)`, except numeric (`gt`/`gte`/`lt`/`lte`: `Number()` on both sides, NaN or empty string never matches) and semver operators (semver 2.0 precedence including prereleases, leading `v` and missing minor/patch allowed, invalid never matches). `in`/`not_in`, `contains`/`not_contains`, `starts_with` and `ends_with` match any of the listed values. An invalid `regex` never matches.
- **Missing attributes** (`undefined` or `null`) match only the negative operators: `neq`, `not_in`, `not_contains` and `not_exists`. All other operators are false.
- **Saved groups**: `in_group` / `not_in_group` ignore the condition's attribute and look up `payload.savedGroups[values[0]]`. A list group matches when `String(attributes[group.attribute])` is one of its values (a missing attribute never matches); a condition group matches when all of its conditions do. A group missing from the payload is never matched (`in_group` false, `not_in_group` true).
- `rollout`: users without the hash attribute (missing or empty string) skip the rule. Otherwise the value is served if `hash(seed, id) < coverage`, and the next rule is tried if not.
- `experiment`: users without the hash attribute skip the rule. With a `namespace` `[key, start, end]` (mutually exclusive experiments), only users whose GrowthBook v1 hash of `"__" + key` falls in `[start, end)` enter; the rest fall through, exactly like GrowthBook's `inNamespace`. Then `hash(seed, id)` picks a GrowthBook-style bucket range. Users outside coverage fall through to the next rule.
