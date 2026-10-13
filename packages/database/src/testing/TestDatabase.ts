import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Layer } from "effect";
import { Miniflare } from "miniflare";
import { Database, makeDatabase } from "../Database";

const migrationsDir = join(import.meta.dirname, "../../migrations");

/** Applies every migration in order, like Alchemy does on deploy */
export const applyMigrations = async (d1: D1Database) => {
  for (const dir of readdirSync(migrationsDir).sort()) {
    const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await d1.batch(statements.map((s) => d1.prepare(s)));
  }
};

/**
 * A real D1 (workerd via Miniflare) with all migrations applied. Each call is an isolated DB.
 * Call `dispose()` in afterAll
 */
export const makeTestD1 = async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch: () => new Response('') }",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(d1);
  return { d1, dispose: () => mf.dispose() };
};

export const TestDatabaseLayer = (d1: D1Database) => Layer.succeed(Database, makeDatabase(d1));
