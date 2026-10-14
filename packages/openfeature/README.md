# @furca/openfeature

[OpenFeature](https://openfeature.dev) providers for [furca](https://github.com/nxsdev/furca). Flags are evaluated locally by [`@furca/sdk`](../sdk/README.md).

```sh
npm install @furca/sdk @furca/openfeature @openfeature/web-sdk     # browser
npm install @furca/sdk @furca/openfeature @openfeature/server-sdk  # Node, Bun, Deno
```

## Web (`@furca/openfeature/web`)

Static context: the evaluation context becomes the furca client's attributes, and exposures are recorded by the client.

```ts
import { OpenFeature } from "@openfeature/web-sdk";
import { createClient } from "@furca/sdk";
import { FurcaWebProvider } from "@furca/openfeature/web";

const furca = createClient({ apiHost: "https://furca.example.com", sdkKey: "sdk_prod_xxx", refreshInterval: 60_000 });
await OpenFeature.setProviderAndWait(new FurcaWebProvider(furca), { targetingKey: user.id, plan: user.plan });

const client = OpenFeature.getClient();
const color = client.getStringValue("button-color", "blue");

await OpenFeature.setContext({ targetingKey: other.id }); // re-targets every flag
furca.track("purchase", 4980);                            // conversions go through the furca client
```

The provider emits `ConfigurationChanged` when a refresh brings a new payload. If the first load fails, it starts in `ERROR` and serves defaults, then becomes `READY` once a refresh succeeds.

## Server (`@furca/openfeature/server`)

Dynamic context: every call evaluates its own context.

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createClient } from "@furca/sdk";
import { FurcaServerProvider } from "@furca/openfeature/server";

// Recommended: a long-lived client. Its payload refreshes are used and exposures are recorded per evaluated user
const furca = createClient({ apiHost: "https://furca.example.com", sdkKey: "sdk_prod_xxx", refreshInterval: 30_000 });
await OpenFeature.setProviderAndWait(new FurcaServerProvider({ client: furca }));

const enabled = await OpenFeature.getClient().getBooleanValue("new-pricing", false, { targetingKey: req.user.id, country: "jp" });
```

Without a client, the provider fetches the payload itself and caches it for `cacheTtl` ms (default 30000; a stale copy is served while it refreshes, a failed refresh keeps the last copy). This mode only evaluates: **experiment exposures are not recorded**, so pass `client` for experiments.

```ts
new FurcaServerProvider({ apiHost: "https://furca.example.com", sdkKey: "sdk_prod_xxx", cacheTtl: 30_000 });
```

## Mapping

| furca | OpenFeature |
| --- | --- |
| `targetingKey` | the `id` attribute (other context fields are passed as attributes) |
| default value (no rule matched) | reason `DEFAULT` |
| force rule | reason `TARGETING_MATCH` |
| percentage rollout | reason `SPLIT` |
| experiment | reason `SPLIT`, `variant` = variation key, `flagMetadata.experimentKey` |
| unknown flag (or disabled in this environment) | default value, error `FLAG_NOT_FOUND` |
| value of another type than requested | default value, error `TYPE_MISMATCH` |
| payload not loaded | default value, error `PROVIDER_NOT_READY` |

`getObjectValue` accepts JSON objects and arrays.
