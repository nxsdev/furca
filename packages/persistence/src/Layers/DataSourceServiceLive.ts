import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { BigQueryConfig, BUILTIN_DATA_SOURCE_ID, DataSource } from "@furca/core/datasources/DataSource";
import { DataSourceService } from "@furca/core/datasources/DataSourceService";
import { ConflictError, NotFoundError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { dataSources } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { toDataSource } from "../mappers";
import { auditInsert, batch, invalid, newId } from "../shared";

/** Error message when the text is not a service account key, else null */
export const checkServiceAccountJson = (json: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      const { client_email, private_key } = parsed as Record<string, unknown>;
      if (typeof client_email === "string" && client_email !== "" && typeof private_key === "string" && private_key !== "") return null;
    }
  } catch {
    // fall through
  }
  return "Paste a service account JSON key (it must contain client_email and private_key)";
};

const validateConfig = (name: string, bigquery: BigQueryConfig, exposureSql: string) => {
  if (name.trim() === "") return invalid("Name is required");
  if (bigquery.projectId.trim() === "") return invalid("Project ID is required");
  if (bigquery.location.trim() === "") return invalid("Location is required");
  if (exposureSql.trim() === "") return invalid("Exposure SQL is required");
  return Effect.void;
};

const configJson = Schema.encodeSync(BigQueryConfig);

export const DataSourceServiceLive = Layer.effect(
  DataSourceService,
  Effect.gen(function* () {
    const database = yield* Database;
    const cipher = yield* CredentialCipher;

    const load = (id: string) =>
      database
        .run("dataSources.get", (db) => db.query.dataSources.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) =>
            row ? Effect.succeed(toDataSource(row)) : Effect.fail(new NotFoundError({ entity: "data source", id })),
          ),
        );

    return {
      list: database
        .run("dataSources.list", (db) => db.query.dataSources.findMany({ orderBy: { createdAt: "asc" } }))
        .pipe(Effect.map((rows) => rows.map(toDataSource))),

      get: load,

      createBigQuery: Effect.fn("DataSourceService.createBigQuery")(function* (input, actor) {
        yield* validateConfig(input.name, input.bigquery, input.exposureSql);
        const credentialsError = checkServiceAccountJson(input.credentialsJson);
        if (credentialsError !== null) return yield* invalid(credentialsError);
        const credentials = yield* cipher.encrypt(input.credentialsJson);
        const now = new Date();
        const source = DataSource.make({
          id: newId(),
          name: input.name.trim(),
          type: "bigquery",
          bigquery: input.bigquery,
          hasCredentials: true,
          exposureSql: input.exposureSql,
          createdAt: now,
          updatedAt: now,
        });
        yield* database.run("dataSources.create", (db) =>
          batch(db, [
            db.insert(dataSources).values({
              id: source.id,
              name: source.name,
              type: source.type,
              config: configJson(input.bigquery),
              credentials,
              exposureSql: source.exposureSql,
              createdAt: now,
              updatedAt: now,
            }),
            auditInsert(db, { entityType: "datasource", entityId: source.id, action: "created", actor, before: null, after: source }),
          ]),
        );
        return source;
      }),

      update: Effect.fn("DataSourceService.update")(function* (input, actor) {
        const before = yield* load(input.id);
        const now = new Date();
        if (before.type === "builtin") {
          if (input.name.trim() === "") return yield* invalid("Name is required");
        } else {
          if (input.bigquery === null) return yield* invalid("BigQuery settings are required");
          yield* validateConfig(input.name, input.bigquery, input.exposureSql);
          if (input.credentialsJson !== null) {
            const credentialsError = checkServiceAccountJson(input.credentialsJson);
            if (credentialsError !== null) return yield* invalid(credentialsError);
          }
        }
        const credentials =
          before.type === "bigquery" && input.credentialsJson !== null ? yield* cipher.encrypt(input.credentialsJson) : undefined;
        const after =
          before.type === "builtin"
            ? DataSource.make({ ...before, name: input.name.trim(), updatedAt: now })
            : DataSource.make({
                ...before,
                name: input.name.trim(),
                bigquery: input.bigquery,
                exposureSql: input.exposureSql,
                hasCredentials: before.hasCredentials || credentials !== undefined,
                updatedAt: now,
              });
        yield* database.run("dataSources.update", (db) =>
          batch(db, [
            db
              .update(dataSources)
              .set({
                name: after.name,
                config: after.bigquery === null ? null : configJson(after.bigquery),
                exposureSql: after.exposureSql,
                updatedAt: now,
                ...(credentials === undefined ? {} : { credentials }),
              })
              .where(eq(dataSources.id, after.id)),
            auditInsert(db, {
              entityType: "datasource",
              entityId: after.id,
              action: credentials === undefined ? "updated" : "credentials.updated",
              actor,
              before,
              after,
            }),
          ]),
        );
        return after;
      }),

      delete: Effect.fn("DataSourceService.delete")(function* (id, actor) {
        const before = yield* load(id);
        if (before.id === BUILTIN_DATA_SOURCE_ID || before.type === "builtin") {
          return yield* new ConflictError({ message: "The built-in event store cannot be deleted" });
        }
        const metric = yield* database.run("metrics.byDataSource", (db) => db.query.metrics.findFirst({ where: { dataSourceId: id } }));
        if (metric !== undefined) return yield* new ConflictError({ message: `The metric "${metric.name}" uses this data source` });
        const experiment = yield* database.run("experiments.byDataSource", (db) =>
          db.query.experiments.findFirst({ where: { dataSourceId: id } }),
        );
        if (experiment !== undefined) {
          return yield* new ConflictError({ message: `The experiment "${experiment.name}" uses this data source` });
        }
        yield* database.run("dataSources.delete", (db) =>
          batch(db, [
            db.delete(dataSources).where(eq(dataSources.id, id)),
            auditInsert(db, { entityType: "datasource", entityId: id, action: "deleted", actor, before, after: null }),
          ]),
        );
      }),
    };
  }),
);
