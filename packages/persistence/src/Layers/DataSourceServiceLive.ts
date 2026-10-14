import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { BUILTIN_DATA_SOURCE_ID, DataSource, WarehouseConfig, type WarehouseType } from "@furca/core/datasources/DataSource";
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

/** Error message for the stored secret of a warehouse type, else null. Never echoes the secret */
export const checkCredentials = (type: WarehouseType, credentials: string): string | null => {
  switch (type) {
    case "bigquery":
      return checkServiceAccountJson(credentials);
    case "snowflake":
      if (credentials.includes("ENCRYPTED PRIVATE KEY")) {
        return "Encrypted private keys are not supported. Paste the unencrypted PKCS#8 key (-----BEGIN PRIVATE KEY-----)";
      }
      if (credentials.includes("BEGIN RSA PRIVATE KEY")) {
        return "This is a PKCS#1 key. Convert it to PKCS#8 with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out rsa_key.p8";
      }
      return /-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(credentials)
        ? null
        : "Paste the private key PEM (it starts with -----BEGIN PRIVATE KEY-----)";
    case "clickhouse":
    case "postgres":
      return credentials === "" ? "Enter the password" : null;
  }
};

const blank = (value: string, message: string) => (value.trim() === "" ? message : null);

/** First problem with a warehouse's connection settings, else null */
export const checkConfig = (c: WarehouseConfig): string | null => {
  switch (c._tag) {
    case "bigquery":
      return blank(c.projectId, "Project ID is required") ?? blank(c.location, "Location is required");
    case "snowflake":
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(c.account.trim()) || /snowflakecomputing/i.test(c.account)) {
        return "Enter the account identifier, e.g. myorg-myaccount (the part before .snowflakecomputing.com)";
      }
      return (
        blank(c.user, "User is required") ??
        blank(c.warehouse, "Warehouse is required") ??
        blank(c.database, "Database is required") ??
        blank(c.schema, "Schema is required")
      );
    case "clickhouse": {
      const url = URL.parse(c.url.trim());
      if (url === null || url.protocol !== "https:") {
        return "Enter the HTTPS URL of the ClickHouse server, e.g. https://abc123.eu-west-1.aws.clickhouse.cloud:8443";
      }
      if (url.username !== "" || url.password !== "") return "Put the user name and password in their own fields, not in the URL";
      return blank(c.database, "Database is required") ?? blank(c.username, "User is required");
    }
    case "postgres":
      if (c.host.trim() === "") return "Host is required";
      if (/[\s/@]/.test(c.host.trim())) return "Enter only the host name, e.g. db.example.com (no scheme, user or path)";
      if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return "Port must be a whole number from 1 to 65535";
      return blank(c.database, "Database is required") ?? blank(c.user, "User is required");
  }
};

const validate = (name: string, config: WarehouseConfig, exposureSql: string) => {
  const problem = blank(name, "Name is required") ?? checkConfig(config) ?? blank(exposureSql, "Exposure SQL is required");
  return problem === null ? Effect.void : invalid(problem);
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
            row ? Effect.succeed(toDataSource(row)) : Effect.fail(new NotFoundError({ entity: "data source", id })),
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
        if (credentialsError !== null) return yield* invalid(credentialsError);
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
          if (input.name.trim() === "") return yield* invalid("Name is required");
        } else {
          if (input.config === null) return yield* invalid("Connection settings are required");
          if (input.config._tag !== before.type) {
            return yield* invalid("A data source cannot change its type. Create a new data source instead");
          }
          yield* validate(input.name, input.config, input.exposureSql);
          if (input.credentials !== null) {
            const credentialsError = checkCredentials(before.type, input.credentials);
            if (credentialsError !== null) return yield* invalid(credentialsError);
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
