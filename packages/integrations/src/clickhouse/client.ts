/**
 * ClickHouse over its HTTPS interface with the official fetch-based client (Workers-safe).
 * `@name` params become typed `{name:Type}` query parameters. No session settings are sent, so
 * users with readonly=1 work. Failures are WarehouseErrors that say what to fix
 */
import { ClickHouseLogLevel, createClient } from "@clickhouse/client-web";
import type { ClickHouseConfig } from "@furca/core/datasources/DataSource";
import type { WarehouseError } from "@furca/core/shared/errors";
import type { Effect } from "effect";
import { attempt, bindParams, fail, type QueryParams, type Row } from "../shared";

const typeOf = (v: string | number) => (typeof v === "string" ? "String" : Number.isInteger(v) ? "Int64" : "Float64");

const explain = (e: unknown, url: string): string => {
  const message = e instanceof Error ? e.message.trim() : String(e);
  // ClickHouseError: a server exception with its type, e.g. UNKNOWN_TABLE
  const type = e instanceof Error && "type" in e ? String(e.type) : null;
  if (type === null) return `ClickHouse: could not reach ${url} (${message}). Check the URL and port (HTTPS is usually 8443)`;
  if (type === "AUTHENTICATION_FAILED" || type === "REQUIRED_PASSWORD") return `ClickHouse: ${message} Check the user name and password`;
  return `ClickHouse: ${message}`;
};

/** Runs one query and returns its rows (64-bit integers arrive as strings, as JSONEachRow prints them) */
export const query = (
  config: ClickHouseConfig,
  password: string,
  sql: string,
  params: QueryParams = {},
  /** Tests pass a fake; defaults to the global fetch */
  fetchImpl?: typeof fetch,
): Effect.Effect<ReadonlyArray<Row>, WarehouseError> =>
  attempt("ClickHouse", "clickhouse.query", async () => {
    const client = createClient({
      url: config.url,
      username: config.username,
      password,
      database: config.database,
      application: "furca",
      // ponytail: no send_progress_in_http_headers (a setting readonly=1 users may not change), so a
      // query idle past a load balancer's timeout can drop; the client's warning about it is muted
      request_timeout: 300_000,
      log: { level: ClickHouseLogLevel.ERROR },
      ...(fetchImpl !== undefined && { fetch: fetchImpl }),
    });
    try {
      const result = await client.query({
        query: bindParams(sql, params, (name, v) => `{${name}:${typeOf(v)}}`),
        query_params: params,
        format: "JSONEachRow",
      });
      return await result.json<Row>();
    } catch (e) {
      return fail(explain(e, config.url));
    } finally {
      await client.close();
    }
  });
