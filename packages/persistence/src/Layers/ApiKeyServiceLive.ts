import { ApiKey } from "@furca/core/platform/ApiKey";
import { ApiKeyService } from "@furca/core/platform/ApiKeyService";
import { BackgroundTasks } from "@furca/core/platform/BackgroundTasks";
import { NotFoundError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { apiKeys } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { toApiKey } from "../mappers";
import { auditInsert, batch, invalid, newId } from "../shared";

const TOUCH_INTERVAL_MS = 60_000;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** SHA-256 hex: what api_keys.secret_hash stores */
export const hashSecret = async (secret: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export const ApiKeyServiceLive = Layer.effect(
  ApiKeyService,
  Effect.gen(function* () {
    const database = yield* Database;
    const background = yield* BackgroundTasks;

    return {
      list: database
        .run("apiKeys.list", (db) => db.query.apiKeys.findMany({ orderBy: { createdAt: "desc" } }))
        .pipe(Effect.map((rows) => rows.map(toApiKey))),

      create: Effect.fn("ApiKeyService.create")(function* (input, actor) {
        const name = input.name.trim();
        if (name === "") return yield* invalid("common.nameRequired", undefined, "name");
        if (name.length > 100) return yield* invalid("apiKey.nameTooLong", { max: 100 }, "name");
        const secret = `furca_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
        const secretHash = yield* Effect.promise(() => hashSecret(secret));
        const apiKey = ApiKey.make({
          id: newId(),
          name,
          prefix: secret.slice(0, 12),
          role: input.role,
          createdBy: actor.email,
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
        });
        yield* database.run("apiKeys.create", (db) =>
          batch(db, [
            db.insert(apiKeys).values({ ...apiKey, secretHash }),
            auditInsert(db, { entityType: "apiKey", entityId: apiKey.id, action: "created", actor, before: null, after: apiKey }),
          ]),
        );
        return { apiKey, secret };
      }),

      revoke: Effect.fn("ApiKeyService.revoke")(function* (id, actor) {
        const row = yield* database.run("apiKeys.get", (db) => db.query.apiKeys.findFirst({ where: { id } }));
        if (row === undefined) return yield* new NotFoundError({ entity: "apiKey", id });
        const before = toApiKey(row);
        if (before.revokedAt !== null) return before;
        const after = ApiKey.make({ ...before, revokedAt: new Date() });
        yield* database.run("apiKeys.revoke", (db) =>
          batch(db, [
            db.update(apiKeys).set({ revokedAt: after.revokedAt }).where(eq(apiKeys.id, id)),
            auditInsert(db, { entityType: "apiKey", entityId: id, action: "revoked", actor, before, after }),
          ]),
        );
        return after;
      }),

      authenticate: Effect.fn("ApiKeyService.authenticate")(function* (secret) {
        const secretHash = yield* Effect.promise(() => hashSecret(secret));
        const row = yield* database.run("apiKeys.bySecret", (db) =>
          db.query.apiKeys.findFirst({ where: { secretHash, revokedAt: { isNull: true } } }),
        );
        if (row === undefined) return null;
        const now = new Date();
        if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
          yield* background.run(
            database
              .run("apiKeys.touch", (db) => db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)))
              .pipe(Effect.asVoid, Effect.catchCause((cause) => Effect.logError("Recording API key use failed", cause))),
          );
        }
        return toApiKey({ ...row, lastUsedAt: now });
      }),
    };
  }),
);
