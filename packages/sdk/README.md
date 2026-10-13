# @kuji/sdk

TypeScript SDK for [kuji](https://github.com/nxsdev/kuji) feature flags and A/B tests.

- Local evaluation: the SDK downloads one JSON payload and evaluates every flag in memory, synchronously.
- Zero dependencies. Runs in browsers, Cloudflare Workers, Node ≥ 20, Bun and Deno.
- Bucketing is byte-compatible with GrowthBook (FNV-1a 32 hash v2), so users keep their buckets when you migrate.

```sh
npm install @kuji/sdk
```

## Browser

```ts
import { createClient } from "@kuji/sdk";

const kuji = createClient({
  apiHost: "https://kuji.example.com",
  sdkKey: "sdk_prod_xxx",
  attributes: { id: user.id, country: "jp", appVersion: "2.3.0" },
  refreshInterval: 60_000, // optional polling, ms (default 0 = never)
});

await kuji.ready(); // never rejects; on failure every flag returns your fallback

if (kuji.isOn("new-checkout")) showNewCheckout();
const color = kuji.getValue("button-color", "blue");

kuji.track("purchase", 4980); // needs an `id` attribute
```

Events and exposures are batched: they are sent every `flushInterval` ms (default 2000) or when `maxBatchSize` (default 100) items are queued. When the page is hidden or unloaded the queue goes out with `navigator.sendBeacon`. Network errors are logged once and never thrown.

## Cloudflare Workers

Workers end when the response is returned, so hand the flush to `ctx.waitUntil`. Fetch the payload once per isolate and reuse it across requests:

```ts
import { createClient, fetchPayload, type SdkPayload } from "@kuji/sdk";

let cache: { payload: SdkPayload; at: number } | undefined;

async function getPayload(env: Env): Promise<SdkPayload | undefined> {
  if (!cache || Date.now() - cache.at > 30_000) {
    try {
      cache = { payload: await fetchPayload({ apiHost: env.KUJI_HOST, sdkKey: env.KUJI_SDK_KEY }), at: Date.now() };
    } catch (e) {
      console.warn("kuji payload refresh failed, keeping last copy", e); // fetchPayload throws, the client never does
    }
  }
  return cache?.payload;
}

export default {
  async fetch(request, env, ctx) {
    const kuji = createClient({
      apiHost: env.KUJI_HOST,
      sdkKey: env.KUJI_SDK_KEY,
      payload: await getPayload(env), // bootstrapped: no fetch, no ready() needed
      attributes: { id: request.headers.get("x-user-id"), country: request.cf?.country },
    });

    const body = kuji.isOn("new-pricing") ? renderNewPricing() : renderPricing();

    ctx.waitUntil(kuji.flush()); // sends exposures/events after the response
    return new Response(body);
  },
} satisfies ExportedHandler<Env>;
```

Calling kuji through a service binding? Pass `fetch: (url, init) => env.KUJI.fetch(url, init)`.

## React

No React dependency ships with the SDK. This hook is all you need:

```tsx
import { useSyncExternalStore } from "react";
import { createClient } from "@kuji/sdk";

export const kuji = createClient({ apiHost: "https://kuji.example.com", sdkKey: "sdk_prod_xxx", attributes: { id: userId } });
void kuji.ready();

export function useFeature<T>(key: string, fallback: T): T {
  return useSyncExternalStore(
    kuji.subscribe,                     // re-renders when the payload changes
    () => kuji.getValue(key, fallback), // keep `fallback` a primitive or a stable reference
    () => fallback,                     // SSR
  );
}

function BuyButton() {
  const color = useFeature("button-color", "blue");
  return <button style={{ background: color }}>Buy</button>;
}
```

`subscribe` fires on payload changes only. After `setAttributes()` (e.g. on login), re-render the tree yourself.

## Sending exposures to GA4 / Segment

`onExposure` is called once per experiment phase, variation and user per client, when the user is first evaluated into an experiment. It runs even with `trackExposures: false`.

```ts
const kuji = createClient({
  apiHost: "https://kuji.example.com",
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
createClient(options: ClientOptions): KujiClient
fetchPayload({ apiHost, sdkKey, fetch? }): Promise<SdkPayload>   // throws on failure

// Pure helpers (server-side evaluation, admin "test a user" simulator)
evaluate(payload: SdkPayload | null | undefined, key: string, attributes: Attributes): Evaluation
evaluateConditions(conditions: PayloadCondition[], attributes: Attributes): boolean
hash(seed: string, value: string): number                         // [0, 1), GrowthBook hash v2
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
| `trackExposures` | `true` | Send exposures to kuji |
| `onExposure` | — | `(exposure) => void` |
| `fetch` | `globalThis.fetch` | Called unbound |

`KujiClient`: `ready()`, `isOn(key)`, `getValue(key, fallback)`, `evaluate(key)`, `setAttributes(attrs)`, `updateAttributes(partial)`, `getAttributes()`, `getPayload()`, `track(name, value?)`, `flush()`, `refresh()`, `subscribe(listener) → unsubscribe`, `destroy()`.

## Evaluation rules

- A feature missing from the payload (unknown, or disabled in this environment) evaluates to `{ value: null, source: "unknown" }`, so `getValue` returns your fallback.
- Rules run top to bottom and the first one that applies wins. If none applies you get the feature's `defaultValue` (`source: "default"`).
- Conditions in a rule are AND-ed. Attribute values are compared as `String(value)`, except numeric (`gt`/`gte`/`lt`/`lte`: `Number()` on both sides, NaN or empty string never matches) and semver operators (semver 2.0 precedence including prereleases, leading `v` and missing minor/patch allowed, invalid never matches). `in`/`not_in`, `contains`/`not_contains`, `starts_with` and `ends_with` match any of the listed values. An invalid `regex` never matches.
- **Missing attributes** (`undefined` or `null`) match only the negative operators: `neq`, `not_in`, `not_contains` and `not_exists`. All other operators are false.
- `rollout`: users without the hash attribute (missing or empty string) skip the rule. Otherwise the value is served if `hash(seed, id) < coverage`, and the next rule is tried if not.
- `experiment`: users without the hash attribute skip the rule. Otherwise `hash(seed, id)` picks a GrowthBook-style bucket range. Users outside coverage fall through to the next rule.
