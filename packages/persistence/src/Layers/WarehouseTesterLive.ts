import { CredentialCipher } from "@kuji/core/datasources/CredentialCipher";
import type { DataSource } from "@kuji/core/datasources/DataSource";
import { WarehouseTester, type WarehouseTestResult } from "@kuji/core/datasources/WarehouseTester";
import { WarehouseError } from "@kuji/core/shared/errors";
import { Database } from "@kuji/database/Database";
import { environments, events } from "@kuji/database/schema/index";
import * as BigQuery from "@kuji/integrations/bigquery/client";
import { and, count, gte, inArray } from "drizzle-orm";
import { Cause, Effect, Layer } from "effect";
import { bigQueryExposureCountsSql } from "./AnalysisSql";

const DAY_MS = 86_400_000;

const size = (bytes: number) => (bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(2)} GB`);

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

    const bigquery = Effect.fn("WarehouseTester.bigquery")(function* (dataSource: DataSource) {
      const row = yield* database.run("dataSources.credentials", (db) =>
        db.query.dataSources.findFirst({ where: { id: dataSource.id }, columns: { credentials: true } }),
      );
      if (dataSource.bigquery === null) return yield* new WarehouseError({ message: "Set the BigQuery project, dataset and location" });
      if (row?.credentials == null) return yield* new WarehouseError({ message: "Add a service account key JSON" });
      const json = yield* cipher.decrypt(row.credentials);
      const sa = yield* BigQuery.parseServiceAccount(json);
      if (dataSource.exposureSql.trim() === "") {
        yield* BigQuery.dryRun(sa, dataSource.bigquery, "SELECT 1");
        return { ok: true, message: `Connected as ${sa.client_email}. Add exposure SQL to validate it`, bytesProcessed: null };
      }
      const now = Date.now();
      const q = bigQueryExposureCountsSql({
        exposureSql: dataSource.exposureSql,
        experimentKey: "kuji-connection-test",
        startMs: now - DAY_MS,
        endMs: now,
      });
      const bytes = yield* BigQuery.dryRun(sa, dataSource.bigquery, q.sql, q.params);
      return {
        ok: true,
        message: `Connected as ${sa.client_email}. The exposure SQL is valid (dry run scans ${size(bytes)})`,
        bytesProcessed: bytes,
      } satisfies WarehouseTestResult;
    });

    return {
      test: (dataSource) =>
        (dataSource.type === "builtin" ? builtin : bigquery(dataSource)).pipe(
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
