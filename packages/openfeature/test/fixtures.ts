import type { SdkPayload } from "@furca/sdk";

export const payload = (generatedAt = "t1"): SdkPayload => ({
  version: 1,
  environment: "production",
  generatedAt,
  features: {
    off: { defaultValue: false, rules: [] },
    pro: { defaultValue: false, rules: [{ type: "force", conditions: [{ attribute: "plan", operator: "eq", values: ["pro"] }], value: true }] },
    everyone: { defaultValue: "a", rules: [{ type: "rollout", conditions: [], value: "b", coverage: 1, hashAttribute: "id", seed: "s" }] },
    limit: { defaultValue: 10, rules: [] },
    config: { defaultValue: { theme: "dark" }, rules: [] },
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

/** Fake furca server: serves `current`, counts payload requests, can fail */
export function fakeServer() {
  const s = {
    current: payload(),
    gets: 0,
    fail: false,
    fetch: async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") return new Response(null, { status: 202 });
      s.gets++;
      return s.fail ? new Response("down", { status: 503 }) : Response.json(s.current);
    },
  };
  return s;
}
