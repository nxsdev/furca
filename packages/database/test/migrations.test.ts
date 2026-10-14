import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { makeDrizzle } from "../src/Database";
import { makeTestD1 } from "../src/testing/TestDatabase";

const t = await makeTestD1();
afterAll(() => t.dispose());

describe("migrations", () => {
  it("seeds production / development environments with distinct SDK keys and the builtin source", async () => {
    const db = makeDrizzle(t.d1);
    const envs = await db.query.environments.findMany({ orderBy: { sortOrder: "asc" } });
    expect(envs.map((e) => e.key)).toEqual(["production", "development"]);
    expect(envs[0]!.sdkKey).toMatch(/^sdk-[0-9a-f]{24}$/);
    expect(envs[0]!.sdkKey).not.toBe(envs[1]!.sdkKey);
    const sources = await db.query.dataSources.findMany();
    expect(sources.map((s) => s.id)).toEqual(["builtin"]);
  });
});

describe("exposure_phase migration", () => {
  it("keeps existing exposures as phase 0 and allows the same unit and variation again in a later phase", async () => {
    const mf = new Miniflare({ modules: true, script: "export default { fetch: () => new Response('') }", d1Databases: { DB: "x" } });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    const dir = join(import.meta.dirname, "../migrations");
    const apply = (name: string) =>
      d1.batch(
        readFileSync(join(dir, name, "migration.sql"), "utf8")
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => d1.prepare(s)),
      );
    const all = readdirSync(dir).sort();
    const target = all.findIndex((d) => d.endsWith("_exposure_phase"));
    for (const name of all.slice(0, target)) await apply(name);
    await d1.prepare("INSERT INTO exposures VALUES ('env_production', 'exp', 'control', 'u1', 1000)").run();
    for (const name of all.slice(target)) await apply(name);

    await d1.prepare("INSERT INTO exposures (environment_id, experiment_key, variation_key, user_id, first_seen_at, phase) VALUES ('env_production', 'exp', 'control', 'u1', 2000, 1)").run();
    const { results } = await d1.prepare("SELECT user_id, first_seen_at, phase FROM exposures ORDER BY phase").all();
    expect(results).toEqual([
      { user_id: "u1", first_seen_at: 1000, phase: 0 },
      { user_id: "u1", first_seen_at: 2000, phase: 1 },
    ]);
    await mf.dispose();
  });
});

describe("roles_approvals migration", () => {
  it("makes the first existing account the owner and everyone else (and pending invitations) admin", async () => {
    const mf = new Miniflare({ modules: true, script: "export default { fetch: () => new Response('') }", d1Databases: { DB: "roles" } });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    const dir = join(import.meta.dirname, "../migrations");
    const apply = (name: string) =>
      d1.batch(
        readFileSync(join(dir, name, "migration.sql"), "utf8")
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => d1.prepare(s)),
      );
    const all = readdirSync(dir).sort();
    const target = all.findIndex((d) => d.endsWith("_roles_approvals"));
    for (const name of all.slice(0, target)) await apply(name);
    await d1
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('b', 'B', 'b@x.com', 2000, 2000), ('a', 'A', 'a@x.com', 1000, 1000)")
      .run();
    await d1.prepare("INSERT INTO invitations (id, email, token, invited_by, expires_at) VALUES ('i', 'c@x.com', 't', 'a', 9999999999999)").run();
    for (const name of all.slice(target)) await apply(name);

    const { results } = await d1.prepare("SELECT id, role FROM user ORDER BY id").all();
    expect(results).toEqual([
      { id: "a", role: "owner" },
      { id: "b", role: "admin" },
    ]);
    expect(await d1.prepare("SELECT role FROM invitations").first()).toEqual({ role: "admin" });
    expect(await d1.prepare("SELECT require_approval FROM environments WHERE id = 'env_production'").first()).toEqual({ require_approval: 0 });
    await mf.dispose();
  });
});
