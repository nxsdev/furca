import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { BUILTIN_DATA_SOURCE_ID, DataSource, WarehouseConfig, type WarehouseType } from "@furca/core/datasources/DataSource";
import { DataSourceService } from "@furca/core/datasources/DataSourceService";
import { ConflictError, type ErrorCode, type Issue, issue, NotFoundError, ValidationError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { dataSources } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { toDataSource } from "../mappers";
import { auditInsert, batch, invalid, newId } from "../shared";

/** Issue when the text is not a service account key, else null */
export const checkServiceAccountJson = (json: string): Issue | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      const { client_email, private_key } = parsed as Record<string, unknown>;
      if (typeof client_email === "string" && client_email !== "" && typeof private_key === "string" && private_key !== "") return null;
    }
  } catch {
    // fall through
  }
  return issue("dataSource.serviceAccountJson", undefined, "credentials");
};

const badCredentials = (code: ErrorCode) => issue(code, undefined, "credentials");

/** Issue with the stored secret of a warehouse type, else null. Never echoes the secret */
export const checkCredentials = (type: WarehouseType, credentials: string): Issue | null => {
  switch (type) {
    case "bigquery":
      return checkServiceAccountJson(credentials);
    case "snowflake":
      if (credentials.includes("ENCRYPTED PRIVATE KEY")) return badCredentials("dataSource.encryptedKey");
      if (credentials.includes("BEGIN RSA PRIVATE KEY")) return badCredentials("dataSource.pkcs1Key");
      return /-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(credentials)
        ? null
        : badCredentials("dataSource.privateKeyPem");
    case "clickhouse":
    case "postgres":
      return credentials === "" ? badCredentials("dataSource.passwordRequired") : null;
  }
};

/** `field`: the form field (WarehouseConfig fields share their names with the form's) */
const blank = (value: string, code: ErrorCode, field: string) => (value.trim() === "" ? issue(code, undefined, field) : null);

/** First problem with a warehouse's connection settings, else null */
export const checkConfig = (c: WarehouseConfig): Issue | null => {
  switch (c._tag) {
    case "bigquery":
      return blank(c.projectId, "dataSource.projectIdRequired", "projectId") ?? blank(c.location, "dataSource.locationRequired", "location");
    case "snowflake":
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(c.account.trim()) || /snowflakecomputing/i.test(c.account)) {
        return issue("dataSource.snowflakeAccount", undefined, "account");
      }
      return (
        blank(c.user, "dataSource.userRequired", "user") ??
        blank(c.warehouse, "dataSource.warehouseRequired", "warehouse") ??
        blank(c.database, "dataSource.databaseRequired", "database") ??
        blank(c.schema, "dataSource.schemaRequired", "schema")
      );
    case "clickhouse": {
      const url = URL.parse(c.url.trim());
      if (url === null || url.protocol !== "https:") return issue("dataSource.clickhouseUrl", undefined, "url");
      if (url.username !== "" || url.password !== "") return issue("dataSource.credentialsInUrl", undefined, "url");
      return blank(c.database, "dataSource.databaseRequired", "database") ?? blank(c.username, "dataSource.userRequired", "user");
    }
    case "postgres":
      if (c.host.trim() === "") return issue("dataSource.hostRequired", undefined, "host");
      if (/[\s/@]/.test(c.host.trim())) return issue("dataSource.hostOnly", undefined, "host");
      if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return issue("dataSource.portRange", undefined, "port");
      return blank(c.database, "dataSource.databaseRequired", "database") ?? blank(c.user, "dataSource.userRequired", "user");
  }
};

const validate = (name: string, config: WarehouseConfig, exposureSql: string) => {
  const problem = blank(name, "common.nameRequired", "name") ?? checkConfig(config) ?? blank(exposureSql, "dataSource.exposureSqlRequired", "sql");
  return problem === null ? Effect.void : Effect.fail(new ValidationError(problem));
};

const configJson = Schema.encodeSync(WarehouseConfig);

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
            row ? Effect.succeed(toDataSource(row)) : Effect.fail(new NotFoundError({ entity: "dataSource", id })),
          ),
        );

    return {
      list: database
        .run("dataSources.list", (db) => db.query.dataSources.findMany({ orderBy: { createdAt: "asc" } }))
        .pipe(Effect.map((rows) => rows.map(toDataSource))),

      get: load,

      create: Effect.fn("DataSourceService.create")(function* (input, actor) {
        yield* validate(input.name, input.config, input.exposureSql);
        const credentialsError = checkCredentials(input.config._tag, input.credentials);
        if (credentialsError !== null) return yield* new ValidationError(credentialsError);
        const credentials = yield* cipher.encrypt(input.credentials);
        const now = new Date();
        const source = DataSource.make({
          id: newId(),
          name: input.name.trim(),
          type: input.config._tag,
          config: input.config,
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
              config: configJson(input.config),
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
          if (input.name.trim() === "") return yield* invalid("common.nameRequired", undefined, "name");
        } else {
          if (input.config === null) return yield* invalid("dataSource.configRequired");
          if (input.config._tag !== before.type) {
            return yield* invalid("dataSource.typeFixed");
          }
          yield* validate(input.name, input.config, input.exposureSql);
          if (input.credentials !== null) {
            const credentialsError = checkCredentials(before.type, input.credentials);
            if (credentialsError !== null) return yield* new ValidationError(credentialsError);
          }
        }
        const credentials =
          before.type !== "builtin" && input.credentials !== null ? yield* cipher.encrypt(input.credentials) : undefined;
        const after =
          before.type === "builtin"
            ? DataSource.make({ ...before, name: input.name.trim(), updatedAt: now })
            : DataSource.make({
                ...before,
                name: input.name.trim(),
                config: input.config,
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
                config: after.config === null ? null : configJson(after.config),
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
          return yield* new ConflictError(issue("dataSource.builtinFixed"));
        }
        const metric = yield* database.run("metrics.byDataSource", (db) => db.query.metrics.findFirst({ where: { dataSourceId: id } }));
        if (metric !== undefined) return yield* new ConflictError(issue("dataSource.usedByMetric", { metric: metric.name }));
        const experiment = yield* database.run("experiments.byDataSource", (db) =>
          db.query.experiments.findFirst({ where: { dataSourceId: id } }),
        );
        if (experiment !== undefined) {
          return yield* new ConflictError(issue("dataSource.usedByExperiment", { experiment: experiment.name }));
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
