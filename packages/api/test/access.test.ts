import { afterAll, describe, expect, it } from "bun:test";
import { makeTestD1 } from "@furca/database/testing/TestDatabase";
import { contract } from "../src/contract";
import type { FurcaEnv } from "../src/Runtime/Env";
import { procedureAccess } from "../src/Runtime/orpc";
import { handleApiRequest } from "../src/Runtime/WorkerEntry";

const t = await makeTestD1();
afterAll(() => t.dispose());

const kv = new Map<string, string>();
const env: FurcaEnv = {
  DB: t.d1,
  KV: {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => void kv.set(key, value),
    delete: async (key: string) => void kv.delete(key),
  } as unknown as KVNamespace,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  ENCRYPTION_KEY: "test-encryption-key-test-encryption-key",
};
const background: Array<Promise<unknown>> = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
const settle = () => Promise.all(background.splice(0));
const ORIGIN = "http://localhost";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const request = (path: string, init: RequestInit = {}) =>
  handleApiRequest(new Request(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, "user-agent": BROWSER, ...init.headers } }), env, ctx);

/** `token`: the one-time token of the invitation (not needed for the first account) */
const signUp = async (email: string, token?: string) => {
  const res = await request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { "x-furca-invitation": token }) },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0], role: "admin" }),
  });
  const body = (await res.json()) as { user?: { id: string }; code?: string };
  return {
    status: res.status,
    code: body.code,
    id: body.user?.id ?? "",
    cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "),
  };
};

const rpc = async (cookie: string, path: string, input?: unknown) => {
  const res = await request(`/api/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ json: input }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : (JSON.parse(text) as { json: any }).json };
};

const rest = async (secret: string, path: string, input?: unknown) => {
  const res = await request(`/api/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(input ?? {}),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : (JSON.parse(text) as any) };
};

const owner = await signUp("owner@example.com");

const invite = async (email: string, role: "admin" | "editor" | "viewer") => {
  const res = await rpc(owner.cookie, "members/invite", { email, role });
  expect(res.status).toBe(200);
  return { id: res.json.id as string, token: (res.json.url as string).split("/").at(-1)! };
};

/** Invites `email` with `role` as the owner, then signs it up through the link */
const join = async (email: string, role: "admin" | "editor" | "viewer") => {
  const member = await signUp(email, (await invite(email, role)).token);
  expect(member.status).toBe(200);
  return member;
};

const admin = await join("admin@example.com", "admin");
const editor = await join("editor@example.com", "editor");
const viewer = await join("viewer@example.com", "viewer");

const flagInput = (key: string) => ({ key, description: "", valueType: "boolean", defaultValue: "false", tags: [] });

describe("procedure classification", () => {
  it("classifies every contract procedure and nothing else", () => {
    const procedures = (c: object) =>
      Object.entries(c)
        .filter(([domain]) => domain !== "public")
        .flatMap(([domain, procs]) => Object.keys(procs as object).map((p) => `${domain}.${p}`))
        .sort();
    expect(procedures(procedureAccess)).toEqual(procedures(contract));
  });
});

describe("invitation sign-up", () => {
  it("requires the invitation's one-time token, for the invited email, while it is pending", async () => {
    const { token } = await invite("token@example.com", "editor");
    expect(await signUp("token@example.com")).toMatchObject({ status: 403, code: "INVITE_ONLY" });
    expect((await signUp("token@example.com", "0".repeat(64))).status).toBe(403);
    // A valid token does not let someone else's address in
    await invite("other@example.com", "admin");
    expect((await signUp("other@example.com", token)).status).toBe(403);

    const joined = await signUp("token@example.com", token);
    expect(joined.status).toBe(200);
    expect((await rpc(joined.cookie, "session/me")).json.role).toBe("editor");
    // Used: the link cannot create a second account
    expect((await signUp("token-again@example.com", token)).status).toBe(403);
  });

  it("rejects an expired invitation", async () => {
    const { id, token } = await invite("late@example.com", "viewer");
    await t.d1.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, id).run();
    expect((await signUp("late@example.com", token)).status).toBe(403);
  });
});

describe("roles", () => {
  it("assigns the owner to the first account and the invitation's role on sign-up, ignoring a role in the body", async () => {
    const roles = Object.fromEntries(
      ((await rpc(owner.cookie, "members/list")).json.members as Array<{ email: string; role: string }>).map((m) => [m.email, m.role]),
    );
    expect(roles).toMatchObject({
      "owner@example.com": "owner",
      "admin@example.com": "admin",
      "editor@example.com": "editor",
      "viewer@example.com": "viewer",
    });
    expect((await rpc(editor.cookie, "session/me")).json.role).toBe("editor");
  });

  it("never lets a member set their own role through Better Auth", async () => {
    const res = await request("/api/auth/update-user", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: viewer.cookie },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(res.status).toBe(400);
    expect((await rpc(viewer.cookie, "session/me")).json.role).toBe("viewer");
  });

  it("lets each role call only what its level allows", async () => {
    const cases: Array<[string, unknown, Record<"viewer" | "editor" | "admin" | "owner", number>]> = [
      ["features/list", { includeArchived: false }, { viewer: 200, editor: 200, admin: 200, owner: 200 }],
      ["changeRequests/list", {}, { viewer: 200, editor: 200, admin: 200, owner: 200 }],
      ["savedGroups/list", undefined, { viewer: 200, editor: 200, admin: 200, owner: 200 }],
      ["apiKeys/list", undefined, { viewer: 403, editor: 403, admin: 200, owner: 200 }],
      ["webhooks/list", undefined, { viewer: 403, editor: 403, admin: 200, owner: 200 }],
    ];
    const users = { viewer, editor, admin, owner };
    for (const [path, input, expected] of cases) {
      for (const [role, user] of Object.entries(users)) {
        expect([path, role, (await rpc(user.cookie, path, input)).status]).toEqual([path, role, expected[role as keyof typeof expected]]);
      }
    }
    for (const [role, user] of Object.entries(users)) {
      const created = await rpc(user.cookie, "features/create", flagInput(`by-${role}`));
      expect([role, created.status]).toEqual([role, role === "viewer" ? 403 : 200]);
      const env = await rpc(user.cookie, "environments/create", { key: `env-${role}`, name: `Env ${role}` });
      expect([role, env.status]).toEqual([role, role === "admin" || role === "owner" ? 200 : 403]);
    }
  });

  it("explains a forbidden call in words", async () => {
    expect((await rpc(viewer.cookie, "features/create", flagInput("nope"))).json.message).toBe(
      "Viewers can't make changes. Ask an admin for editor access",
    );
    // `data.code` lets the admin UI show it in the user's language
    expect((await rpc(editor.cookie, "apiKeys/create", { name: "x", role: "admin" })).json).toMatchObject({
      message: "Only admins can manage API keys",
      data: { code: "access.apiKeys" },
    });
    expect((await rpc(editor.cookie, "members/invite", { email: "x@example.com", role: "admin" })).json.message).toBe(
      "Only admins can manage members",
    );
  });

  it("hides pending invitation links from non-admins", async () => {
    await rpc(owner.cookie, "members/invite", { email: "pending@example.com", role: "admin" });
    expect((await rpc(viewer.cookie, "members/list")).json.invitations).toEqual([]);
    expect((await rpc(admin.cookie, "members/list")).json.invitations.map((i: { email: string; role: string }) => [i.email, i.role])).toContainEqual([
      "pending@example.com",
      "admin",
    ]);
  });

  it("maps admin API keys to admin and readonly keys to viewer", async () => {
    const key = async (role: "admin" | "readonly") => (await rpc(owner.cookie, "apiKeys/create", { name: role, role })).json.secret as string;
    const adminKey = await key("admin");
    const readonlyKey = await key("readonly");
    expect((await rest(adminKey, "environments/update", { id: "env_development", name: "Development" })).status).toBe(200);
    expect((await rest(readonlyKey, "features/list", { includeArchived: false })).status).toBe(200);
    const write = await rest(readonlyKey, "features/create", flagInput("readonly"));
    expect([write.status, write.json.message]).toEqual([403, "This API key is read-only"]);
  });
});

describe("members.setRole", () => {
  it("lets admins change roles, audits it, and takes effect on the next request", async () => {
    const member = await join("promote@example.com", "viewer");
    expect((await rpc(member.cookie, "features/create", flagInput("before-promotion"))).status).toBe(403);
    const updated = await rpc(admin.cookie, "members/setRole", { id: member.id, role: "editor" });
    expect([updated.status, updated.json.role]).toEqual([200, "editor"]);
    expect((await rpc(member.cookie, "features/create", flagInput("after-promotion"))).status).toBe(200);
    const audit = await rpc(owner.cookie, "audit/list", { entityType: "member", entityId: member.id, before: null, limit: 5 });
    expect(audit.json.map((a: { action: string; actorEmail: string }) => [a.action, a.actorEmail])).toEqual([["role.updated", "admin@example.com"]]);
  });

  it("never changes the owner, never grants owner, and keeps editors out", async () => {
    const owned = await rpc(admin.cookie, "members/setRole", { id: owner.id, role: "viewer" });
    expect([owned.status, owned.json.message]).toEqual([403, "The owner's role can't be changed"]);
    expect((await rpc(owner.cookie, "members/setRole", { id: admin.id, role: "owner" })).status).toBe(400);
    expect((await rpc(editor.cookie, "members/setRole", { id: viewer.id, role: "editor" })).status).toBe(403);
    expect((await rpc(admin.cookie, "members/remove", { id: owner.id })).status).toBe(403);
  });

  it("refuses to demote the last admin", async () => {
    // A database whose owner row is gone (only possible outside the API) has one admin left
    await t.d1.prepare("UPDATE user SET role = 'viewer' WHERE id = ?").bind(owner.id).run();
    const others = (await rpc(admin.cookie, "members/list")).json.members.filter((m: { role: string; id: string }) => m.role === "admin" && m.id !== admin.id);
    for (const m of others) await t.d1.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(m.id).run();
    const demoted = await rpc(admin.cookie, "members/setRole", { id: admin.id, role: "editor" });
    expect([demoted.status, demoted.json.message]).toEqual([409, "At least one admin must remain. Make someone else an admin first"]);
    await t.d1.prepare("UPDATE user SET role = 'owner' WHERE id = ?").bind(owner.id).run();
  });
});

describe("change requests", () => {
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://hooks.test/")) return realFetch(input, init);
    sent.push({ url, body: String(init?.body) });
    return new Response("ok");
  }) as typeof fetch;
  afterAll(() => void (globalThis.fetch = realFetch));

  const protectedEnv = "env_production";
  const sdkKey = async () =>
    (await t.d1.prepare("select sdk_key from environments where id = ?").bind(protectedEnv).first<{ sdk_key: string }>())!.sdk_key;
  const newFlag = async (key: string) => (await rpc(editor.cookie, "features/create", flagInput(key))).json.id as string;
  const forceRule = { _tag: "force", id: "r1", description: "", enabled: true, conditions: [], value: "true" };

  it("only admins turn on Require review, and then direct changes there are refused", async () => {
    expect((await rpc(editor.cookie, "environments/setRequireApproval", { id: protectedEnv, requireApproval: true })).status).toBe(403);
    const on = await rpc(admin.cookie, "environments/setRequireApproval", { id: protectedEnv, requireApproval: true });
    expect([on.status, on.json.requireApproval]).toEqual([200, true]);

    const id = await newFlag("guarded");
    for (const user of [editor, admin, owner]) {
      const toggle = await rpc(user.cookie, "features/setEnabled", { id, environmentId: protectedEnv, enabled: true });
      expect([toggle.status, toggle.json.message]).toEqual([403, "Production requires a review"]);
    }
    expect((await rpc(admin.cookie, "features/saveRules", { id, environmentId: protectedEnv, rules: [forceRule] })).status).toBe(403);
    // Other environments are unaffected
    expect((await rpc(editor.cookie, "features/setEnabled", { id, environmentId: "env_development", enabled: true })).status).toBe(200);
  });

  it("applies an approved toggle, republishes, audits and emits flag.updated", async () => {
    await rpc(owner.cookie, "webhooks/create", { name: "Reviews", url: "https://hooks.test/reviews", format: "json", events: ["flag.updated"] });
    const id = await newFlag("reviewed-toggle");
    const created = await rpc(editor.cookie, "changeRequests/create", {
      featureId: id,
      environmentId: protectedEnv,
      change: { type: "toggle", enabled: true },
      comment: "Launch",
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ status: "open", featureKey: "reviewed-toggle", base: { enabled: false, rules: [] }, authorEmail: "editor@example.com" });
    expect((await rpc(viewer.cookie, "changeRequests/list", { status: "open", featureId: id })).json.map((c: { id: string }) => c.id)).toEqual([
      created.json.id,
    ]);

    await settle();
    sent.splice(0);
    const approved = await rpc(admin.cookie, "changeRequests/approve", { id: created.json.id, comment: "Ship it" });
    expect(approved.json).toMatchObject({ status: "approved", reviewerEmail: "admin@example.com", reviewComment: "Ship it" });
    const flag = await rpc(viewer.cookie, "features/get", { id });
    expect(flag.json.environments.find((e: { environmentId: string }) => e.environmentId === protectedEnv).enabled).toBe(true);
    const payload = JSON.parse(kv.get(`payload:${await sdkKey()}`)!) as { features: Record<string, unknown> };
    expect(payload.features["reviewed-toggle"]).toBeDefined();

    const audit = await rpc(owner.cookie, "audit/list", { entityType: "feature", entityId: id, before: null, limit: 10 });
    const rows = audit.json.map((a: { action: string; actorEmail: string }) => [a.action, a.actorEmail]);
    // The approval and the applied change share one batch and timestamp, so their order is not fixed
    expect([...rows.slice(0, 2)].sort()).toEqual([
      ["enabled", "admin@example.com"],
      ["review.approved", "admin@example.com"],
    ]);
    expect(rows.slice(2)).toEqual([
      ["review.requested", "editor@example.com"],
      ["created", "editor@example.com"],
    ]);
    await settle();
    expect(sent.map((s) => JSON.parse(s.body).data)).toEqual([
      { flag: { id, key: "reviewed-toggle" }, action: "enabled", environmentIds: [protectedEnv], actor: "admin@example.com" },
    ]);
    expect((await rpc(admin.cookie, "changeRequests/approve", { id: created.json.id, comment: "" })).status).toBe(409);
  });

  it("applies approved rules", async () => {
    const id = await newFlag("reviewed-rules");
    const created = await rpc(editor.cookie, "changeRequests/create", {
      featureId: id,
      environmentId: protectedEnv,
      change: { type: "rules", rules: [forceRule] },
      comment: "",
    });
    expect((await rpc(owner.cookie, "changeRequests/approve", { id: created.json.id, comment: "" })).status).toBe(200);
    const flag = await rpc(viewer.cookie, "features/get", { id });
    expect(flag.json.environments.find((e: { environmentId: string }) => e.environmentId === protectedEnv).rules).toEqual([forceRule]);
  });

  it("refuses an approval by the author, by an editor, and a request that changes nothing or has invalid rules", async () => {
    const id = await newFlag("self-approve");
    const mine = await rpc(admin.cookie, "changeRequests/create", {
      featureId: id,
      environmentId: protectedEnv,
      change: { type: "toggle", enabled: true },
      comment: "",
    });
    const self = await rpc(admin.cookie, "changeRequests/approve", { id: mine.json.id, comment: "" });
    expect([self.status, self.json.message]).toEqual([403, "You can't approve your own request. Ask another admin"]);
    const byEditor = await rpc(editor.cookie, "changeRequests/approve", { id: mine.json.id, comment: "" });
    expect([byEditor.status, byEditor.json.message]).toEqual([403, "Only admins can approve or reject reviews"]);
    expect((await rpc(viewer.cookie, "changeRequests/create", { featureId: id, environmentId: protectedEnv, change: { type: "toggle", enabled: true }, comment: "" })).status).toBe(403);

    const noop = await rpc(editor.cookie, "changeRequests/create", { featureId: id, environmentId: protectedEnv, change: { type: "toggle", enabled: false }, comment: "" });
    expect(noop.status).toBe(400);
    const invalid = await rpc(editor.cookie, "changeRequests/create", {
      featureId: id,
      environmentId: protectedEnv,
      change: { type: "rules", rules: [{ ...forceRule, value: "\"text\"" }] },
      comment: "",
    });
    expect([invalid.status, invalid.json.message]).toEqual([400, "Rule 1: Expected true or false"]);
  });

  it("refuses to approve a request whose flag changed since it was opened", async () => {
    const id = await newFlag("stale-base");
    const open = (change: unknown) =>
      rpc(editor.cookie, "changeRequests/create", { featureId: id, environmentId: protectedEnv, change, comment: "" });
    const toggle = await open({ type: "toggle", enabled: true });
    const rules = await open({ type: "rules", rules: [forceRule] });
    expect((await rpc(admin.cookie, "changeRequests/approve", { id: toggle.json.id, comment: "" })).status).toBe(200);
    const stale = await rpc(admin.cookie, "changeRequests/approve", { id: rules.json.id, comment: "" });
    expect([stale.status, stale.json.message]).toEqual([409, "The flag changed since this request; open a new one"]);
    const flag = await rpc(viewer.cookie, "features/get", { id });
    expect(flag.json.environments.find((e: { environmentId: string }) => e.environmentId === protectedEnv).rules).toEqual([]);
  });

  it("rejects and cancels without touching the flag; only the author or an admin cancels", async () => {
    const id = await newFlag("closed-requests");
    const open = () =>
      rpc(editor.cookie, "changeRequests/create", { featureId: id, environmentId: protectedEnv, change: { type: "toggle", enabled: true }, comment: "" });
    const first = await open();
    const rejected = await rpc(admin.cookie, "changeRequests/reject", { id: first.json.id, comment: "Not this week" });
    expect(rejected.json).toMatchObject({ status: "rejected", reviewComment: "Not this week" });

    const second = await open();
    const other = await join("other-editor@example.com", "editor");
    const notMine = await rpc(other.cookie, "changeRequests/cancel", { id: second.json.id });
    expect([notMine.status, notMine.json.message]).toEqual([403, "Only the author or an admin can cancel this request"]);
    expect((await rpc(editor.cookie, "changeRequests/cancel", { id: second.json.id })).json.status).toBe("cancelled");
    expect((await rpc(admin.cookie, "changeRequests/approve", { id: second.json.id, comment: "" })).status).toBe(409);

    const third = await open();
    expect((await rpc(admin.cookie, "changeRequests/cancel", { id: third.json.id })).json.status).toBe("cancelled");

    const flag = await rpc(viewer.cookie, "features/get", { id });
    expect(flag.json.environments.find((e: { environmentId: string }) => e.environmentId === protectedEnv).enabled).toBe(false);
    const audit = await rpc(owner.cookie, "audit/list", { entityType: "feature", entityId: id, before: null, limit: 10 });
    expect(audit.json.map((a: { action: string }) => a.action)).toEqual([
      "review.cancelled",
      "review.requested",
      "review.cancelled",
      "review.requested",
      "review.rejected",
      "review.requested",
      "created",
    ]);
  });
});
