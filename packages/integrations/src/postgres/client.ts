/**
 * Postgres (and wire-compatible: Redshift, Neon, Supabase, ...) with porsager/postgres. In workerd it
 * connects through `cloudflare:sockets` (the package's `workerd` export). One connection per query,
 * always closed: Workers cannot share sockets across requests. `@name` params become typed `$n`
 * placeholders; the session runs in UTC. Failures are WarehouseErrors that say what to fix
 */
import type { PostgresConfig } from "@furca/core/datasources/DataSource";
import type { WarehouseError } from "@furca/core/shared/errors";
import type { Effect } from "effect";
import postgres from "postgres";
import { attempt, bindParams, fail, type QueryParams, type Row } from "../shared";

/** The driver; tests swap `connect` for a fake (bun test has no Postgres to talk to) */
export const driver: { connect: typeof postgres } = { connect: postgres };

const typeOf = (v: string | number) => (typeof v === "string" ? "TEXT" : Number.isInteger(v) ? "BIGINT" : "DOUBLE PRECISION");

const explain = (e: unknown, config: PostgresConfig): string => {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "PostgresError") {
    const code = "code" in e ? String(e.code) : "";
    // 28P01 invalid_password, 28000 invalid_authorization_specification
    return code.startsWith("28") ? `Postgres: ${message}. Check the user name and password` : `Postgres: ${message}`;
  }
  return `Postgres: could not connect to ${config.host}:${config.port} (${message}). Check the host, port and SSL setting, and that the database accepts connections from the internet`;
};

/** Runs one query on a fresh connection and closes it. bigint / numeric values arrive as strings */
export const query = (
  config: PostgresConfig,
  password: string,
  sql: string,
  params: QueryParams = {},
): Effect.Effect<ReadonlyArray<Row>, WarehouseError> =>
  attempt("Postgres", "postgres.query", async () => {
    const values: Array<string | number> = [];
    const index = new Map<string, number>();
    const text = bindParams(sql, params, (name, v) => {
      const i = index.get(name) ?? values.push(v);
      index.set(name, i);
      return `CAST($${i} AS ${typeOf(v)})`;
    });
    const client = driver.connect({
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
      password,
      ssl: config.ssl === "require" ? "require" : false,
      // Transaction-mode poolers (PgBouncer, Supavisor) cannot keep prepared statements
      prepare: false,
      fetch_types: false,
      max: 1,
      connect_timeout: 10,
      idle_timeout: 1,
      // Startup parameters PgBouncer passes through
      connection: { application_name: "furca", TimeZone: "UTC" },
      onnotice: () => {},
    });
    try {
      const rows = await client.unsafe(text, values);
      return rows.map((r) => ({ ...r }));
    } catch (e) {
      return fail(explain(e, config));
    } finally {
      await client.end({ timeout: 1 });
    }
  });
