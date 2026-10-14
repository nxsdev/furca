import type { Evaluation, FurcaClient } from "@furca/sdk";
import { createContext, type ReactNode, useCallback, useContext, useRef, useSyncExternalStore } from "react";

const FurcaContext = createContext<FurcaClient | null>(null);

/** Makes `client` available to the hooks below. Call `client.ready()` yourself (hooks return fallbacks until then) */
export function FurcaProvider({ client, children }: { client: FurcaClient; children?: ReactNode }) {
  return <FurcaContext.Provider value={client}>{children}</FurcaContext.Provider>;
}

/** The client from the nearest `<FurcaProvider>` */
export function useFurca(): FurcaClient {
  const client = useContext(FurcaContext);
  if (!client) throw new Error("[furca] useFurca() needs a <FurcaProvider client={...}> above it");
  return client;
}

/**
 * Re-renders when the client's payload or attributes change. The same snapshot serves SSR: a server client
 * bootstrapped with a payload renders real values, one without renders fallbacks. Hydration matches as long
 * as the browser client starts from the same payload (or, like the server, from none)
 */
function useClientSnapshot<T>(read: (client: FurcaClient) => T): T {
  const client = useFurca();
  const subscribe = useCallback((onChange: () => void) => client.subscribe(() => onChange()), [client]);
  const get = () => read(client);
  return useSyncExternalStore(subscribe, get, get);
}

/** Full evaluation (value, source, experiment assignment). Records the exposure like `client.evaluate` */
export function useEvaluation<T = unknown>(key: string): Evaluation<T> {
  // evaluate() builds a new object per call, but a snapshot must be stable: reuse it until the client
  // swaps its payload or attributes (the client replaces both, never mutates them)
  const cache = useRef<{ client: FurcaClient; payload: unknown; attributes: unknown; ev: Evaluation<T> } | null>(null);
  return useClientSnapshot((client) => {
    const payload = client.getPayload();
    const attributes = client.getAttributes();
    const c = cache.current;
    if (c && c.client === client && c.payload === payload && c.attributes === attributes && c.ev.key === key) return c.ev;
    const ev = client.evaluate<T>(key);
    cache.current = { client, payload, attributes, ev };
    return ev;
  });
}

/** Like `client.getValue`: the flag's value, or `fallback` when it is unknown or not loaded yet */
export function useFeatureValue<T>(key: string, fallback: T): T {
  // Snapshot the payload value (stable reference), not the fallback, so inline object fallbacks are fine
  const value = useClientSnapshot((client) => client.evaluate<T>(key).value);
  return value === null ? fallback : value;
}

/** True only when the flag's value is exactly `true` */
export function useFeatureIsOn(key: string): boolean {
  return useClientSnapshot((client) => client.evaluate(key).value === true);
}

/** Renders `children` only when the flag is on */
export function IfFeatureEnabled({ feature, children }: { feature: string; children?: ReactNode }) {
  return <>{useFeatureIsOn(feature) ? children : null}</>;
}
