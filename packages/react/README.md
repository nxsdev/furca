# @furca/react

React bindings for [furca](https://github.com/nxsdev/furca) feature flags and A/B tests, built on [`@furca/sdk`](../sdk/README.md).

```sh
npm install @furca/sdk @furca/react
```

```tsx
import { createClient } from "@furca/sdk";
import { FurcaProvider, IfFeatureEnabled, useFeatureIsOn, useFeatureValue } from "@furca/react";

const furca = createClient({ apiHost: "https://furca.example.com", sdkKey: "sdk_prod_xxx", attributes: { id: user.id } });
void furca.ready(); // hooks return fallbacks until the payload arrives, then re-render

export function App() {
  return (
    <FurcaProvider client={furca}>
      <Checkout />
    </FurcaProvider>
  );
}

function Checkout() {
  const color = useFeatureValue("button-color", "blue");
  const fastPay = useFeatureIsOn("fast-pay");
  return (
    <>
      <button style={{ background: color }}>{fastPay ? "Pay now" : "Continue"}</button>
      <IfFeatureEnabled feature="gift-wrap">
        <GiftWrapOption />
      </IfFeatureEnabled>
    </>
  );
}
```

Components re-render when the payload refreshes (`refreshInterval`, `refresh()`) and when attributes change, e.g. on login:

```ts
furca.updateAttributes({ id: user.id, plan: user.plan });
```

## API

| | |
| --- | --- |
| `<FurcaProvider client>` | Makes a `FurcaClient` available to the hooks |
| `useFurca()` | The client, e.g. for `track()` |
| `useFeatureValue(key, fallback)` | The flag's value, or `fallback` while unknown / not loaded. Inline object fallbacks are fine |
| `useFeatureIsOn(key)` | `true` only when the value is exactly `true` |
| `useEvaluation(key)` | Full `Evaluation`: `value`, `source`, `ruleIndex`, `experiment` (`{ key, variationKey }`) |
| `<IfFeatureEnabled feature>` | Renders its children only when the flag is on |

Hooks evaluate like `client.evaluate`, so experiment exposures are recorded the first time a user sees a variation.

## Server-side rendering

The hooks render on the server with the same client logic. Give the server-side client the payload (`createClient({ sdkKey, payload, attributes })`, see `fetchPayload` in the SDK README) to render real values; without one it renders fallbacks. To hydrate without a mismatch, start the browser client from the same payload, e.g. serialized into the page:

```ts
const furca = createClient({ apiHost, sdkKey, payload: window.__FURCA_PAYLOAD__, attributes: { id: user.id } });
```

A browser client without a payload renders fallbacks first and updates once `ready()` resolves; that only matches a server render that also had no payload.
