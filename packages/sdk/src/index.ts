import type {
  Attributes,
  Evaluation,
  EvaluationSource,
  EventsBody,
  PayloadCondition,
  PayloadSavedGroup,
  SdkPayload,
} from "./types.ts";

export type * from "./types.ts";

export type Exposure = NonNullable<EventsBody["exposures"]>[number];
export type TrackedEvent = NonNullable<EventsBody["events"]>[number];
export type EventProperties = NonNullable<TrackedEvent["properties"]>;

// ---------------------------------------------------------------------------
// Hashing (GrowthBook-compatible: v2 for bucketing, v1 for namespaces)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit over UTF-16 code units, same as GrowthBook's fnv32a */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Deterministic bucket in [0, 1). Identical to GrowthBook `hash(seed, value, version)`: v2 (default) has 4 decimals, v1 has 3 */
export function hash(seed: string, value: string, version: 1 | 2 = 2): number {
  if (version === 1) return (fnv1a32(value + seed) % 1000) / 1000;
  return (fnv1a32(String(fnv1a32(seed + value))) % 10000) / 10000;
}

/** Same as GrowthBook `inNamespace`: the user's v1 hash of ("__" + key) falls in [start, end) */
export function inNamespace(hashValue: string, [key, start, end]: readonly [string, number, number]): boolean {
  const n = hash(`__${key}`, hashValue, 1);
  return n >= start && n < end;
}

/** Same as GrowthBook `getBucketRanges`: coverage clamped to [0,1], invalid weights → equal split */
export function getBucketRanges(
  numVariations: number,
  coverage = 1,
  weights?: ReadonlyArray<number>,
): Array<[number, number]> {
  const cov = Math.min(1, Math.max(0, coverage));
  const equal = Array.from({ length: Math.max(0, numVariations) }, () => 1 / numVariations);
  let w = weights && weights.length === numVariations ? weights : equal;
  const total = w.reduce((a, b) => a + b, 0);
  if (total < 0.99 || total > 1.01) w = equal;
  let cumulative = 0;
  return w.map((x) => {
    const start = cumulative;
    cumulative += x;
    return [start, start + cov * x];
  });
}

/** Index of the range containing n (half-open), or -1 */
export function chooseVariation(n: number, ranges: ReadonlyArray<readonly [number, number]>): number {
  return ranges.findIndex(([start, end]) => n >= start && n < end);
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const getAttr = (attributes: Attributes, name: string): unknown =>
  Object.hasOwn(attributes, name) ? attributes[name] : undefined;

/** Empty / whitespace strings are not numbers (Number("") would be 0) */
const num = (x: unknown): number => (typeof x === "string" && x.trim() === "" ? NaN : Number(x));

const SEMVER = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_ID = /^\d+$/;

/** semver 2.0.0 precedence (missing minor/patch = 0, leading "v" allowed). null when either side is invalid */
function compareSemver(a: string, b: string): number | null {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i] ?? 0) - Number(y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  const p = x[4];
  const q = y[4];
  if (p === q) return 0;
  if (p === undefined) return 1; // release > prerelease
  if (q === undefined) return -1;
  const ps = p.split(".");
  const qs = q.split(".");
  for (let i = 0; i < Math.max(ps.length, qs.length); i++) {
    const s = ps[i];
    const t = qs[i];
    if (s === undefined) return -1; // fewer identifiers = lower
    if (t === undefined) return 1;
    const sn = NUMERIC_ID.test(s);
    const tn = NUMERIC_ID.test(t);
    const d = sn && tn ? Number(s) - Number(t) : sn ? -1 : tn ? 1 : s < t ? -1 : s > t ? 1 : 0;
    if (d) return Math.sign(d);
  }
  return 0;
}

type SavedGroups = Readonly<Record<string, PayloadSavedGroup>>;

function inGroup(id: string | undefined, attributes: Attributes, savedGroups: SavedGroups | undefined): boolean {
  const group = id !== undefined && savedGroups && Object.hasOwn(savedGroups, id) ? savedGroups[id] : undefined;
  if (group?.type === "list") {
    const raw = getAttr(attributes, group.attribute);
    // ponytail: O(n) scan of up to 10k values per evaluation; cache a Set per group if this shows up in profiles
    return raw !== undefined && raw !== null && group.values.includes(String(raw));
  }
  // Groups cannot reference groups (the server rejects it), so nested in_group stays unresolved: no cycles
  if (group?.type === "condition") return evaluateConditions(group.conditions, attributes);
  return false; // missing group (deleted, or from a newer server)
}

function evalCondition(
  { attribute, operator, values }: PayloadCondition,
  attributes: Attributes,
  savedGroups: SavedGroups | undefined,
): boolean {
  // Group operators ignore `attribute`, so they run before the missing-attribute rule
  if (operator === "in_group") return inGroup(values[0], attributes, savedGroups);
  if (operator === "not_in_group") return !inGroup(values[0], attributes, savedGroups);
  const raw = getAttr(attributes, attribute);
  // Missing (undefined/null) attribute: only negative operators match. "Not equal to X" / "not in list" /
  // "does not contain" are all true of a user who has no value at all.
  if (raw === undefined || raw === null) {
    return operator === "neq" || operator === "not_in" || operator === "not_contains" || operator === "not_exists";
  }
  const s = String(raw);
  const v = values[0];
  switch (operator) {
    case "eq":
      return s === v;
    case "neq":
      return s !== v;
    case "in":
      return values.includes(s);
    case "not_in":
      return !values.includes(s);
    case "contains":
      return values.some((x) => s.includes(x));
    case "not_contains":
      return !values.some((x) => s.includes(x));
    case "starts_with":
      return values.some((x) => s.startsWith(x));
    case "ends_with":
      return values.some((x) => s.endsWith(x));
    case "regex":
      if (v === undefined) return false;
      try {
        return new RegExp(v).test(s);
      } catch {
        return false;
      }
    // NaN on either side makes every comparison false
    case "gt":
      return num(raw) > num(v);
    case "gte":
      return num(raw) >= num(v);
    case "lt":
      return num(raw) < num(v);
    case "lte":
      return num(raw) <= num(v);
    case "semver_gt":
    case "semver_gte":
    case "semver_lt":
    case "semver_lte": {
      const c = v === undefined ? null : compareSemver(s, v);
      if (c === null) return false;
      return operator === "semver_gt" ? c > 0 : operator === "semver_gte" ? c >= 0 : operator === "semver_lt" ? c < 0 : c <= 0;
    }
    case "exists":
      return true;
    case "not_exists":
      return false;
    default:
      return false; // unknown operator from a newer server: never match
  }
}

/** All conditions must match (AND). Empty list matches everyone. Pass `payload.savedGroups` for in_group / not_in_group */
export function evaluateConditions(
  conditions: ReadonlyArray<PayloadCondition>,
  attributes: Attributes,
  savedGroups?: SdkPayload["savedGroups"],
): boolean {
  return conditions.every((c) => evalCondition(c, attributes, savedGroups));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const result = <T>(
  key: string,
  value: unknown,
  source: EvaluationSource,
  ruleIndex: number,
  experiment: Evaluation["experiment"] = null,
): Evaluation<T> => ({ key, value: (value ?? null) as T | null, source, ruleIndex, experiment });

/** Evaluate one feature for a user. Pure and synchronous; safe on servers and in the admin UI */
export function evaluate<T = unknown>(
  payload: SdkPayload | null | undefined,
  key: string,
  attributes: Attributes,
): Evaluation<T> {
  const feature = payload && Object.hasOwn(payload.features, key) ? payload.features[key] : undefined;
  if (!feature) return result(key, null, "unknown", -1);
  for (let i = 0; i < feature.rules.length; i++) {
    const rule = feature.rules[i]!;
    if (!evaluateConditions(rule.conditions, attributes, payload?.savedGroups)) continue;
    if (rule.type === "force") return result(key, rule.value, "force", i);
    if (rule.type !== "rollout" && rule.type !== "experiment") continue; // unknown rule type from a newer server
    const id = getAttr(attributes, rule.hashAttribute);
    const hashValue = id === undefined || id === null ? "" : String(id);
    if (!hashValue) continue;
    if (rule.type === "rollout") {
      if (hash(rule.seed, hashValue) < rule.coverage) return result(key, rule.value, "rollout", i);
      continue;
    }
    if (rule.namespace && !inNamespace(hashValue, rule.namespace)) continue; // another experiment owns this slice
    const v = chooseVariation(hash(rule.seed, hashValue), getBucketRanges(rule.variations.length, rule.coverage, rule.weights));
    const variation = rule.variations[v];
    if (!variation) continue; // outside coverage: not in experiment
    return result(key, variation.value, "experiment", i, { key: rule.key, variationKey: variation.key });
  }
  return result(key, feature.defaultValue, "default", -1);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const trimHost = (apiHost: string) => apiHost.replace(/\/+$/, "");

/**
 * Fetch the payload once. Unlike the client, this THROWS on network/HTTP/format errors so
 * server-side caches can keep serving their last good copy.
 */
export async function fetchPayload(options: { apiHost: string; sdkKey: string; fetch?: FetchFn }): Promise<SdkPayload> {
  const f: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const res = await f(`${trimHost(options.apiHost)}/api/sdk/v1/payload/${encodeURIComponent(options.sdkKey)}`);
  if (!res.ok) throw new Error(`[furca] payload request failed: HTTP ${res.status}`);
  const payload = (await res.json()) as SdkPayload;
  if (payload?.version !== 1 || typeof payload.features !== "object" || payload.features === null) {
    throw new Error("[furca] unsupported payload format");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  sdkKey: string;
  /** e.g. "https://furca.example.com". Required unless `payload` is given */
  apiHost?: string;
  attributes?: Attributes;
  /** Bootstrapped payload (SSR / Workers). When set, `ready()` does not fetch */
  payload?: SdkPayload;
  /** Payload polling in ms. 0 = never (default) */
  refreshInterval?: number;
  /** Max delay before queued events are sent, ms. Default 2000. 0 = only on size / flush() */
  flushInterval?: number;
  /** Flush as soon as this many exposures+events are queued. Default 100 */
  maxBatchSize?: number;
  /** Send exposures to furca. Default true. `onExposure` is called either way */
  trackExposures?: boolean;
  /** Called once per (experiment, phase, variation, user) per client, e.g. to forward to GA4/Segment */
  onExposure?: (exposure: Exposure) => void;
  /** Custom fetch (tests, service bindings). Called unbound */
  fetch?: FetchFn;
}

export interface FurcaClient {
  /** Resolves once the payload is loaded (or failed to load). Never rejects */
  ready(): Promise<void>;
  isOn(key: string): boolean;
  getValue<T>(key: string, fallback: T): T;
  /**
   * Full result. Pass `attributes` to evaluate for another user without touching the client's own
   * attributes (one long-lived server client for all requests); exposures are recorded for that user
   */
  evaluate<T = unknown>(key: string, attributes?: Attributes): Evaluation<T>;
  setAttributes(attributes: Attributes): void;
  updateAttributes(attributes: Attributes): void;
  getAttributes(): Attributes;
  getPayload(): SdkPayload | null;
  /**
   * Record a conversion event for the `id` attribute. `properties` are flat (string / number / boolean),
   * max 20 keys of ≤ 64 chars; strings are cut to 200 chars. Invalid entries are dropped with a warning
   */
  track(name: string, value?: number | null, properties?: EventProperties): void;
  /** Sends queued events and waits for in-flight sends. Never rejects. On Workers: `ctx.waitUntil(client.flush())` */
  flush(): Promise<void>;
  /** Re-fetch the payload; notifies subscribers when it changed. Never rejects */
  refresh(): Promise<void>;
  /** Called when the payload or the attributes change (only once a payload is loaded). Returns an unsubscribe function */
  subscribe(listener: (payload: SdkPayload) => void): () => void;
  /** Stops timers and listeners and sends whatever is queued */
  destroy(): void;
}

const warned = new Set<string>();
const warnOnce = (msg: string, err?: unknown) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[furca] ${msg}`, ...(err === undefined ? [] : [err]));
};

/** Wire limits from EventsBody: flat values, ≤ 20 keys of ≤ 64 chars, strings ≤ 200 chars */
function cleanProperties(properties: Readonly<Record<string, unknown>>): EventProperties | undefined {
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  let dropped = false;
  for (const [k, v] of Object.entries(properties)) {
    const flat = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
    if (!flat || k === "" || k.length > 64 || n >= 20) {
      dropped = true;
      continue;
    }
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
    n++;
  }
  if (dropped) warnOnce("track(): dropped properties (values must be string / number / boolean, max 20 keys of 64 chars)");
  return n ? out : undefined;
}

/** Exposure breakdown values: String(), ≤ 100 chars, missing attributes skipped */
function dimensionsOf(names: ReadonlyArray<string>, attributes: Attributes): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = getAttr(attributes, name);
    if (v !== undefined && v !== null) out[name] = String(v).slice(0, 100);
  }
  return out;
}

export function createClient(options: ClientOptions): FurcaClient {
  const { sdkKey, apiHost, onExposure } = options;
  if (!apiHost && !options.payload) throw new Error("[furca] createClient needs `apiHost` or `payload`");
  const flushInterval = options.flushInterval ?? 2000;
  const maxBatchSize = options.maxBatchSize ?? 100;
  const trackExposures = options.trackExposures ?? true;
  const doFetch: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const eventsUrl = apiHost ? `${trimHost(apiHost)}/api/sdk/v1/events/${encodeURIComponent(sdkKey)}` : null;

  let payload: SdkPayload | null = options.payload ?? null;
  let attributes: Attributes = { ...options.attributes };
  let exposures: Exposure[] = [];
  let events: TrackedEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let readyPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  const seen = new Set<string>();
  const listeners = new Set<(payload: SdkPayload) => void>();

  const notify = () => {
    if (!payload) return; // nothing evaluates differently without a payload
    for (const l of listeners) {
      try {
        l(payload);
      } catch (e) {
        console.error("[furca] subscriber threw", e);
      }
    }
  };

  const refresh = async (): Promise<void> => {
    if (!apiHost) return;
    try {
      const next = await fetchPayload({ apiHost, sdkKey, fetch: doFetch });
      const changed = !payload || payload.generatedAt !== next.generatedAt || payload.environment !== next.environment;
      payload = next;
      if (changed) notify();
    } catch (e) {
      warnOnce("could not load payload; using fallbacks / last known payload", e);
    }
  };

  const takeBatch = (): EventsBody | null => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!exposures.length && !events.length) return null;
    const body: EventsBody = { exposures, events };
    exposures = [];
    events = [];
    if (!eventsUrl) {
      warnOnce("no apiHost: dropping events");
      return null;
    }
    return body;
  };

  const send = async (body: EventsBody) => {
    // text/plain keeps it a CORS "simple request" (no preflight); the server parses it as JSON
    const init: RequestInit = { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await doFetch(eventsUrl!, init);
        if (res.ok) return;
        if (res.status < 500) break; // 4xx won't get better on retry
      } catch {}
    }
    warnOnce("could not send events; dropping batch");
  };

  const dispatch = (body: EventsBody) => {
    const p = send(body);
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const flush = async (): Promise<void> => {
    const body = takeBatch();
    if (body) dispatch(body);
    await Promise.all(inFlight);
  };

  const enqueued = () => {
    if (exposures.length + events.length >= maxBatchSize) void flush();
    else if (flushTimer === undefined && flushInterval > 0) flushTimer = setTimeout(() => void flush(), flushInterval);
  };

  const clientEvaluate = <T>(key: string, attrs: Attributes = attributes): Evaluation<T> => {
    const ev = evaluate<T>(payload, key, attrs);
    const rule = ev.experiment ? payload!.features[key]!.rules[ev.ruleIndex] : undefined;
    if (ev.experiment && rule?.type === "experiment") {
      const userId = String(getAttr(attrs, rule.hashAttribute));
      const dedupeKey = `${ev.experiment.key}\0${rule.phase}\0${ev.experiment.variationKey}\0${userId}`;
      if (!seen.has(dedupeKey)) {
        // ponytail: bounded memory for long-lived server clients; may re-send a few duplicate exposures after a clear
        if (seen.size >= 10_000) seen.clear();
        seen.add(dedupeKey);
        const exposure: Exposure = {
          experimentKey: ev.experiment.key,
          variationKey: ev.experiment.variationKey,
          phase: rule.phase,
          userId,
          ...(rule.dimensions?.length ? { dimensions: dimensionsOf(rule.dimensions, attrs) } : {}),
          ts: Date.now(),
        };
        if (trackExposures) {
          exposures.push(exposure);
          enqueued();
        }
        try {
          onExposure?.(exposure);
        } catch (e) {
          console.error("[furca] onExposure threw", e);
        }
      }
    }
    return ev;
  };

  // Browsers: hand the queue to sendBeacon when the page is hidden / unloaded
  // (Safari may fire pagehide while still "visible", so only visibilitychange checks the state)
  const onHide = (e: Event) => {
    if (e.type === "visibilitychange" && document.visibilityState !== "hidden") return;
    const body = takeBatch();
    if (!body) return;
    const sent = typeof navigator !== "undefined" && navigator.sendBeacon?.(eventsUrl!, JSON.stringify(body));
    if (!sent) dispatch(body);
  };
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined" && !!window.addEventListener;
  if (isBrowser) {
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  if (apiHost && options.refreshInterval && options.refreshInterval > 0) {
    pollTimer = setInterval(() => void refresh(), options.refreshInterval);
    (pollTimer as { unref?: () => void }).unref?.(); // don't keep Node/Bun processes alive
  }

  return {
    ready: () => (readyPromise ??= options.payload ? Promise.resolve() : refresh()),
    isOn: (key) => clientEvaluate(key).value === true,
    getValue: <T>(key: string, fallback: T): T => {
      const v = clientEvaluate<T>(key).value;
      return v === null ? fallback : v;
    },
    evaluate: clientEvaluate,
    setAttributes: (attrs) => {
      attributes = { ...attrs };
      notify();
    },
    updateAttributes: (attrs) => {
      attributes = { ...attributes, ...attrs };
      notify();
    },
    getAttributes: () => attributes,
    getPayload: () => payload,
    track: (name, value, properties) => {
      const id = getAttr(attributes, "id");
      if (id === undefined || id === null || id === "") {
        warnOnce("track() needs an `id` attribute; event dropped");
        return;
      }
      const props = properties && cleanProperties(properties);
      events.push({ name, userId: String(id), value: value ?? null, ...(props ? { properties: props } : {}), ts: Date.now() });
      enqueued();
    },
    flush,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    destroy: () => {
      clearInterval(pollTimer);
      if (isBrowser) {
        window.removeEventListener("pagehide", onHide);
        document.removeEventListener("visibilitychange", onHide);
      }
      listeners.clear();
      void flush();
    },
  };
}
