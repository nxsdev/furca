import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createClient, type FurcaClient, type SdkPayload } from "@furca/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { FurcaProvider, IfFeatureEnabled, useEvaluation, useFeatureIsOn, useFeatureValue, useFurca } from "../src/index.tsx";

const payload = (generatedAt: string, color: string): SdkPayload => ({
  version: 1,
  environment: "production",
  generatedAt,
  features: {
    color: { defaultValue: color, rules: [] },
    beta: { defaultValue: false, rules: [{ type: "force", conditions: [{ attribute: "plan", operator: "eq", values: ["pro"] }], value: true }] },
    config: { defaultValue: { size: 2 }, rules: [] },
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
          variations: [{ key: "control", value: "a" }, { key: "treatment", value: "b" }],
          weights: [0.5, 0.5],
        },
      ],
    },
  },
});

/** A real client against a fake server whose payload the test swaps */
function makeClient(initial?: SdkPayload) {
  const server = { current: payload("t1", "red") };
  const client = createClient({
    sdkKey: "k",
    apiHost: "https://furca.test",
    payload: initial,
    attributes: { id: "u1" },
    trackExposures: false,
    fetch: async () => Response.json(server.current),
  });
  return { client, server };
}

function Probe() {
  const color = useFeatureValue("color", "fallback");
  const config = useFeatureValue("config", { size: 0 }); // inline object fallback must not loop
  const beta = useFeatureIsOn("beta");
  const ev = useEvaluation<string>("exp");
  return <p>{`${color}|${config.size}|${beta}|${ev.source}:${ev.experiment?.variationKey ?? "-"}`}</p>;
}

describe("SSR (react-dom/server)", () => {
  test("a bootstrapped client renders real values; one without a payload renders fallbacks", () => {
    const { client } = makeClient(payload("t1", "red"));
    const html = (c: FurcaClient) =>
      renderToString(
        <FurcaProvider client={c}>
          <Probe />
          <IfFeatureEnabled feature="beta">BETA</IfFeatureEnabled>
        </FurcaProvider>,
      );
    expect(html(client)).toMatch(/red\|2\|false\|experiment:(control|treatment)/);
    expect(html(client)).not.toContain("BETA");
    client.updateAttributes({ plan: "pro" });
    expect(html(client)).toContain("BETA");
    expect(html(makeClient().client)).toContain("fallback|0|false|unknown:-");
  });

  test("hooks outside <FurcaProvider> throw a clear error", () => {
    spyOn(console, "error").mockImplementation(() => {});
    function Lonely() {
      useFurca();
      return null;
    }
    expect(() => renderToString(<Lonely />)).toThrow(/FurcaProvider/);
  });
});

// --- a DOM just big enough for react-dom/client (no DOM library in this repo) ----------------------
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeValue: string | null = null;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  constructor(
    public nodeType: number,
    public ownerDocument: unknown,
    public tagName = "",
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  appendChild(c: FakeNode) {
    c.parentNode?.removeChild(c);
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(c: FakeNode, ref: FakeNode) {
    c.parentNode?.removeChild(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: FakeNode) {
    this.childNodes.splice(this.childNodes.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  addEventListener() {}
  removeEventListener() {}
  get textContent(): string {
    return this.nodeType === 3 ? this.nodeValue! : this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(text: string) {
    this.childNodes = [];
    if (text) this.appendChild(Object.assign(new FakeNode(3, this.ownerDocument), { nodeValue: text }));
  }
}

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.window;
  delete g.document;
});

async function mount(client: FurcaClient) {
  const doc = {
    activeElement: null,
    body: null,
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag: string): FakeNode => new FakeNode(1, doc, tag.toUpperCase()),
    createTextNode: (text: string) => Object.assign(new FakeNode(3, doc), { nodeValue: text }),
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = { HTMLIFrameElement: class {}, document: doc };
  g.document = doc;
  const container = new FakeNode(1, doc, "DIV");
  const root = createRoot(container as unknown as Element);
  await act(() =>
    root.render(
      <FurcaProvider client={client}>
        <Probe />
        <IfFeatureEnabled feature="beta">BETA</IfFeatureEnabled>
      </FurcaProvider>,
    ),
  );
  return { text: () => container.textContent, unmount: () => act(() => root.unmount()) };
}

describe("browser (react-dom/client)", () => {
  test("re-renders when the payload loads and changes", async () => {
    const { client, server } = makeClient();
    const view = await mount(client);
    expect(view.text()).toStartWith("fallback|0|false|unknown");
    await act(() => client.ready());
    expect(view.text()).toStartWith("red|2|false|experiment");
    server.current = payload("t2", "blue");
    await act(() => client.refresh());
    expect(view.text()).toStartWith("blue|2|false|experiment");
    await view.unmount();
  });

  test("re-renders when attributes change", async () => {
    const { client } = makeClient(payload("t1", "red"));
    const view = await mount(client);
    expect(view.text()).not.toContain("BETA");
    await act(() => client.updateAttributes({ plan: "pro" }));
    expect(view.text()).toContain("|true|");
    expect(view.text()).toEndWith("BETA");
    await act(() => client.setAttributes({ id: "u1" }));
    expect(view.text()).not.toContain("BETA");
    await view.unmount();
  });

  test("unmount unsubscribes from the client", async () => {
    const { client } = makeClient(payload("t1", "red"));
    let active = 0;
    const subscribe = client.subscribe;
    client.subscribe = (listener) => {
      active++;
      const off = subscribe(listener);
      return () => {
        active--;
        off();
      };
    };
    const view = await mount(client);
    expect(active).toBe(5); // one per hook: 4 in <Probe>, 1 in <IfFeatureEnabled>
    await view.unmount();
    expect(active).toBe(0);
  });
});
