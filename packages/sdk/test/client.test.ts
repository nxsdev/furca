import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createClient, fetchPayload, type EventsBody, type Exposure, type FurcaClient, type SdkPayload } from "../src/index.ts";

beforeAll(() => {
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

const payload = (generatedAt = "2026-01-01T00:00:00Z"): SdkPayload => ({
  version: 1,
  environment: "production",
  generatedAt,
  features: {
    flag: { defaultValue: true, rules: [] },
    color: { defaultValue: "red", rules: [] },
    exp: {
      defaultValue: "none",
      rules: [
        {
          type: "experiment",
          key: "exp-key",
          conditions: [],
          coverage: 1,
          hashAttribute: "id",
          seed: "s",
          phase: 0,
          variations: [
            { key: "control", value: "a" },
            { key: "treatment", value: "b" },
          ],
          weights: [0.5, 0.5],
        },
      ],
    },
  },
});

/** Fake fetch: serves `current` for payload GETs, records event POSTs */
function fakeServer() {
  const s = {
    current: payload(),
    posts: [] as EventsBody[],
    calls: [] as string[],
    fail: false as false | "throw" | 500,
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      s.calls.push(`${init?.method ?? "GET"} ${url}`);
      if (s.fail === "throw") throw new TypeError("network down");
      if (s.fail) return new Response("boom", { status: s.fail });
      if (init?.method === "POST") {
        s.posts.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      return Response.json(s.current);
    },
  };
  return s;
}

const clients: FurcaClient[] = [];
const make = (o: Partial<Parameters<typeof createClient>[0]> & { fetch: (u: string, i?: RequestInit) => Promise<Response> }) => {
  const c = createClient({ sdkKey: "sdk-key", apiHost: "https://furca.test/", attributes: { id: "user-1" }, flushInterval: 0, ...o });
  clients.push(c);
  return c;
};
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
});

describe("client", () => {
  test("ready() fetches payload once; values work", async () => {
    const s = fakeServer();
    const c = make({ fetch: s.fetch });
    expect(c.getValue("color", "fallback")).toBe("fallback"); // before ready
    await Promise.all([c.ready(), c.ready()]);
    expect(s.calls).toEqual(["GET https://furca.test/api/sdk/v1/payload/sdk-key"]);
    expect(c.isOn("flag")).toBe(true);
    expect(c.getValue("color", "fallback")).toBe("red");
    expect(c.getValue("missing", 7)).toBe(7);
    expect(c.evaluate("missing").source).toBe("unknown");
  });

  test("bootstrapped payload: ready() does not fetch; no apiHost is fine", async () => {
    const s = fakeServer();
    const c = createClient({ sdkKey: "k", payload: payload(), fetch: s.fetch });
    await c.ready();
    expect(s.calls).toEqual([]);
    expect(c.isOn("flag")).toBe(true);
    c.track("x");
    await c.flush(); // dropped with a warning, no throw
    expect(() => createClient({ sdkKey: "k" })).toThrow();
  });

  test("experiment exposures are deduped per (experiment, variation, user) and forwarded", async () => {
    const s = fakeServer();
    const seen: Exposure[] = [];
    const c = make({ fetch: s.fetch, payload: payload(), onExposure: (e) => seen.push(e) });
    c.getValue("exp", "x");
    c.evaluate("exp");
    c.isOn("exp");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ experimentKey: "exp-key", userId: "user-1" });
    c.setAttributes({ id: "user-2" });
    c.evaluate("exp");
    c.evaluate("flag"); // not an experiment
    expect(seen.map((e) => e.userId)).toEqual(["user-1", "user-2"]);
    await c.flush();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.exposures!.map((e) => e.userId)).toEqual(["user-1", "user-2"]);
    expect(s.posts[0]!.exposures![0]).toMatchObject({ experimentKey: "exp-key", phase: 0 });
    expect(s.calls.at(-1)).toBe("POST https://furca.test/api/sdk/v1/events/sdk-key");
  });

  test("a new experiment phase re-sends the exposure of an already exposed user", async () => {
    const s = fakeServer();
    const c = make({ fetch: s.fetch, payload: payload() });
    c.evaluate("exp");
    s.current = payload("2026-01-02T00:00:00Z");
    const rule = s.current.features.exp!.rules[0] as { phase: number };
    rule.phase = 1;
    await c.refresh();
    c.evaluate("exp");
    c.evaluate("exp");
    await c.flush();
    expect(s.posts[0]!.exposures!.map((e) => e.phase)).toEqual([0, 1]);
  });

  test("trackExposures: false still calls onExposure but sends nothing", async () => {
    const s = fakeServer();
    let n = 0;
    const c = make({ fetch: s.fetch, payload: payload(), trackExposures: false, onExposure: () => n++ });
    c.evaluate("exp");
    await c.flush();
    expect(n).toBe(1);
    expect(s.posts).toHaveLength(0);
  });

  test("throwing onExposure does not break evaluation", () => {
    const s = fakeServer();
    const c = make({ fetch: s.fetch, payload: payload(), onExposure: () => { throw new Error("gtag missing"); } });
    expect(["a", "b"]).toContain(c.getValue("exp", "x"));
  });

  test("track batches by size and by interval", async () => {
    const s = fakeServer();
    const c = make({ fetch: s.fetch, payload: payload(), maxBatchSize: 3, flushInterval: 20 });
    c.track("a", 1);
    c.track("b");
    expect(s.posts).toHaveLength(0);
    c.track("c", 3);
    await c.flush();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.events!.map((e) => [e.name, e.value, e.userId])).toEqual([
      ["a", 1, "user-1"],
      ["b", null, "user-1"],
      ["c", 3, "user-1"],
    ]);
    c.track("d");
    await Bun.sleep(60);
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1]!.events!.map((e) => e.name)).toEqual(["d"]);
  });

  test("track without id attribute is a no-op", async () => {
    const s = fakeServer();
    const c = make({ fetch: s.fetch, payload: payload(), attributes: {} });
    c.track("a");
    c.updateAttributes({ id: 5 });
    c.track("b");
    await c.flush();
    expect(s.posts[0]!.events!.map((e) => [e.name, e.userId])).toEqual([["b", "5"]]);
  });

  test("never throws on network failure", async () => {
    for (const fail of ["throw", 500] as const) {
      const s = fakeServer();
      s.fail = fail;
      const c = make({ fetch: s.fetch });
      await c.ready();
      await c.refresh();
      expect(c.isOn("flag")).toBe(false);
      expect(c.getValue("color", "fallback")).toBe("fallback");
      c.track("a");
      await c.flush();
      // payload GET x2, events POST retried once
      expect(s.calls.filter((x) => x.startsWith("POST"))).toHaveLength(2);
    }
  });

  test("custom fetch that throws synchronously-ish is contained", async () => {
    const c = make({ fetch: () => Promise.reject(new Error("nope")), payload: payload() });
    c.track("a");
    await c.flush();
    await c.refresh();
    expect(c.isOn("flag")).toBe(true); // keeps last known payload
  });

  test("subscribe fires only when the payload changes", async () => {
    const s = fakeServer();
    const c = make({ fetch: s.fetch });
    const got: string[] = [];
    const unsubscribe = c.subscribe((p) => got.push(p.generatedAt));
    await c.ready();
    await c.refresh();
    s.current = payload("2026-02-02T00:00:00Z");
    await c.refresh();
    unsubscribe();
    s.current = payload("2026-03-03T00:00:00Z");
    await c.refresh();
    expect(got).toEqual(["2026-01-01T00:00:00Z", "2026-02-02T00:00:00Z"]);
    expect(c.getPayload()?.generatedAt).toBe("2026-03-03T00:00:00Z");
  });

  test("refreshInterval polls", async () => {
    const s = fakeServer();
    make({ fetch: s.fetch, refreshInterval: 10 });
    await Bun.sleep(45);
    expect(s.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("flush() waits for sends already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let done = false;
    const c = make({
      payload: payload(),
      maxBatchSize: 1,
      fetch: async () => {
        await gate;
        done = true;
        return new Response(null, { status: 202 });
      },
    });
    c.track("a"); // size-triggered background send
    const flushed = c.flush();
    release();
    await flushed;
    expect(done).toBe(true);
  });
});

test("browser: queue goes to sendBeacon on pagehide / hidden", () => {
  const g = globalThis as Record<string, unknown>;
  const beacons: Array<[string, string]> = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
  g.window = new EventTarget();
  g.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: (url: string, body: string) => (beacons.push([url, body]), true) });
  try {
    const c = createClient({ sdkKey: "sdk-key", apiHost: "https://furca.test", attributes: { id: "u" }, payload: payload(), fetch: fakeServer().fetch });
    c.track("a");
    (g.document as EventTarget).dispatchEvent(new Event("visibilitychange")); // still visible: nothing
    expect(beacons).toHaveLength(0);
    (g.window as EventTarget).dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]![0]).toBe("https://furca.test/api/sdk/v1/events/sdk-key");
    expect((JSON.parse(beacons[0]![1]) as EventsBody).events!.map((e) => e.name)).toEqual(["a"]);
    c.track("b");
    (g.document as { visibilityState: string }).visibilityState = "hidden";
    (g.document as EventTarget).dispatchEvent(new Event("visibilitychange"));
    expect(beacons).toHaveLength(2);
    c.destroy();
  } finally {
    delete g.window;
    delete g.document;
    if (original) Object.defineProperty(navigator, "sendBeacon", original);
    else delete (navigator as unknown as Record<string, unknown>).sendBeacon;
  }
});

describe("fetchPayload", () => {
  test("returns payload; throws on HTTP or format errors", async () => {
    const s = fakeServer();
    expect((await fetchPayload({ apiHost: "https://furca.test", sdkKey: "a b", fetch: s.fetch })).version).toBe(1);
    expect(s.calls).toEqual(["GET https://furca.test/api/sdk/v1/payload/a%20b"]);
    s.fail = 500;
    await expect(fetchPayload({ apiHost: "https://furca.test", sdkKey: "k", fetch: s.fetch })).rejects.toThrow();
    const bad = async () => Response.json({ hello: "world" });
    await expect(fetchPayload({ apiHost: "https://furca.test", sdkKey: "k", fetch: bad })).rejects.toThrow();
  });
});
