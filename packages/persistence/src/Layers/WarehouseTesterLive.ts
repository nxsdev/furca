import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import type { DataSource, WarehouseType } from "@furca/core/datasources/DataSource";
import { WarehouseTester, type WarehouseTestResult } from "@furca/core/datasources/WarehouseTester";
import { WarehouseError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { environments, events } from "@furca/database/schema/index";
import * as Warehouse from "@furca/integrations/warehouse";
import { and, count, gte, inArray } from "drizzle-orm";
import { Cause, Effect, Layer } from "effect";
import { warehouseExposureCountsSql } from "./AnalysisSql";

const DAY_MS = 86_400_000;

const size = (bytes: number) => (bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`);

const MISSING_CREDENTIALS: Record<WarehouseType, string> = {
  bigquery: "Add a service account key JSON",
  snowflake: "Add the user's private key",
  clickhouse: "Add the password",
  postgres: "Add the password",
};

export const WarehouseTesterLive = Layer.effect(
  WarehouseTester,
  Effect.gen(function* () {
    const database = yield* Database;
    const cipher = yield* CredentialCipher;

    const builtin = Effect.gen(function* () {
      const envs = yield* database.run("environments.ids", (db) => db.select({ id: environments.id }).from(environments));
      const [row] = yield* database.run("events.count30d", (db) =>
        db
          .select({ n: count() })
          .from(events)
          .where(and(inArray(events.environmentId, envs.map((e) => e.id)), gte(events.ts, Date.now() - 30 * DAY_MS))),
      );
      const n = row?.n ?? 0;
      return {
        ok: true,
        message: `Built-in event store: ${n.toLocaleString("en-US")} events in the last 30 days`,
        bytesProcessed: null,
      } satisfies WarehouseTestResult;
    });

    /** Authenticates, then compiles the wrapped exposure SQL without reading data (dry run or LIMIT 0) */
    const warehouse = Effect.fn("WarehouseTester.warehouse")(function* (dataSource: DataSource) {
      const config = dataSource.config;
      if (config === null) return yield* new WarehouseError({ message: "Fill in the connection settings" });
      const row = yield* database.run("dataSources.credentials", (db) =>
        db.query.dataSources.findFirst({ where: { id: dataSource.id }, columns: { credentials: true } }),
      );
      if (row?.credentials == null) return yield* new WarehouseError({ message: MISSING_CREDENTIALS[config._tag] });
      const client = yield* Warehouse.connect(config, yield* cipher.decrypt(row.credentials));
      if (dataSource.exposureSql.trim() === "") {
        yield* client.check("SELECT 1", {});
        return { ok: true, message: `Connected as ${client.identity}. Add exposure SQL to validate it`, bytesProcessed: null };
      }
      const now = Date.now();
      const q = warehouseExposureCountsSql(config._tag, {
        exposureSql: dataSource.exposureSql,
        experimentKey: "furca-connection-test",
        startMs: now - DAY_MS,
        endMs: now,
      });
      const bytes = yield* client.check(q.sql, q.params);
      return {
        ok: true,
        message:
          bytes === null
            ? `Connected as ${client.identity}. The exposure SQL is valid`
            : `Connected as ${client.identity}. The exposure SQL is valid (dry run scans ${size(bytes)})`,
        bytesProcessed: bytes,
      } satisfies WarehouseTestResult;
    });

    return {
      test: (dataSource) =>
        (dataSource.type === "builtin" ? builtin : warehouse(dataSource)).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const userFacing = error instanceof Error && "_tag" in error && (error._tag === "WarehouseError" || error._tag === "ValidationError");
            return (userFacing ? Effect.void : Effect.logError("Connection test failed", cause)).pipe(
              Effect.as({
                ok: false,
                message: userFacing ? error.message : "The connection test failed unexpectedly. Try again",
                bytesProcessed: null,
              }),
            );
          }),
        ),
    };
  }),
);
