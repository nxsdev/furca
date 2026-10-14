import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import { BackgroundTasks } from "@furca/core/platform/BackgroundTasks";
import { Webhook } from "@furca/core/platform/Webhook";
import { WebhookDispatcher, type WebhookInput, WebhookService } from "@furca/core/platform/WebhookService";
import { NotFoundError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { webhooks } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { toWebhook } from "../mappers";
import { auditInsert, batch, invalid, newId, randomHex } from "../shared";
import { signWebhookBody, slackText, type WebhookMessage } from "../webhooks";

const TIMEOUT_MS = 5_000;

type Row = typeof webhooks.$inferSelect;
type Outcome = { readonly status: number | null; readonly error: string | null };

const validate = (input: WebhookInput) => {
  const name = input.name.trim();
  const url = input.url.trim();
  if (name === "") return invalid("common.nameRequired", undefined, "name");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid("webhook.urlInvalid", undefined, "url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return invalid("webhook.urlScheme", undefined, "url");
  if (input.events.length === 0) return invalid("webhook.eventRequired", undefined, "events");
  return Effect.succeed({ name, url, format: input.format, events: [...new Set(input.events)] });
};

// ponytail: one attempt, no retries; the outcome is shown in Settings and "Send test" re-checks the endpoint
const post = async (url: string, body: string, headers: Record<string, string>): Promise<Outcome> => {
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    return { status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return { status: null, error: "Timed out after 5 seconds" };
    return { status: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
  }
};

const makeDelivery = Effect.gen(function* () {
  const database = yield* Database;
  const cipher = yield* CredentialCipher;

  const environmentNames = database
    .run("environments.names", (db) => db.query.environments.findMany({ columns: { id: true, name: true } }))
    .pipe(Effect.map((rows) => new Map(rows.map((r) => [r.id, r.name]))));

  /** Signs and POSTs one message, then records the outcome on the webhook */
  const deliver = Effect.fn("Webhooks.deliver")(function* (row: Row, message: WebhookMessage, names: ReadonlyMap<string, string>) {
    const secret = yield* cipher.decrypt(row.secret);
    const id = newId();
    const body =
      row.format === "slack"
        ? JSON.stringify({ text: slackText(message, (envId) => names.get(envId) ?? envId) })
        : JSON.stringify({ id, event: message.event, createdAt: new Date().toISOString(), data: message.data });
    const signature = yield* Effect.promise(() => signWebhookBody(secret, body));
    const outcome = yield* Effect.promise(() =>
      post(row.url, body, {
        "content-type": "application/json",
        "user-agent": "furca-webhooks",
        "furca-event": message.event,
        "furca-delivery": id,
        "furca-signature": signature,
      }),
    );
    yield* database.run("webhooks.delivered", (db) =>
      db
        .update(webhooks)
        .set({ lastDeliveredAt: new Date(), lastStatus: outcome.status, lastError: outcome.error })
        .where(eq(webhooks.id, row.id)),
    );
    return outcome;
  });

  return { database, cipher, environmentNames, deliver };
});

export const WebhookServiceLive = Layer.effect(
  WebhookService,
  Effect.gen(function* () {
    const { database, cipher, deliver } = yield* makeDelivery;

    const load = (id: string) =>
      database
        .run("webhooks.get", (db) => db.query.webhooks.findFirst({ where: { id } }))
        .pipe(Effect.filterOrFail((row) => row !== undefined, () => new NotFoundError({ entity: "webhook", id })));

    return {
      list: database
        .run("webhooks.list", (db) => db.query.webhooks.findMany({ orderBy: { createdAt: "asc" } }))
        .pipe(Effect.map((rows) => rows.map(toWebhook))),

      create: Effect.fn("WebhookService.create")(function* (input, actor) {
        const fields = yield* validate(input);
        const secret = `whsec_${randomHex(24)}`;
        const encrypted = yield* cipher.encrypt(secret);
        const now = new Date();
        const webhook = Webhook.make({
          id: newId(),
          ...fields,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          lastDeliveredAt: null,
          lastStatus: null,
          lastError: null,
        });
        yield* database.run("webhooks.create", (db) =>
          batch(db, [
            db.insert(webhooks).values({ ...webhook, events: [...webhook.events], secret: encrypted }),
            auditInsert(db, { entityType: "webhook", entityId: webhook.id, action: "created", actor, before: null, after: webhook }),
          ]),
        );
        return { webhook, secret };
      }),

      update: Effect.fn("WebhookService.update")(function* (input, actor) {
        const before = toWebhook(yield* load(input.id));
        const fields = yield* validate(input);
        const after = Webhook.make({ ...before, ...fields, enabled: input.enabled, updatedAt: new Date() });
        yield* database.run("webhooks.update", (db) =>
          batch(db, [
            db
              .update(webhooks)
              .set({ ...fields, enabled: after.enabled, updatedAt: after.updatedAt })
              .where(eq(webhooks.id, after.id)),
            auditInsert(db, { entityType: "webhook", entityId: after.id, action: "updated", actor, before, after }),
          ]),
        );
        return after;
      }),

      delete: Effect.fn("WebhookService.delete")(function* (id, actor) {
        const before = toWebhook(yield* load(id));
        yield* database.run("webhooks.delete", (db) =>
          batch(db, [
            db.delete(webhooks).where(eq(webhooks.id, id)),
            auditInsert(db, { entityType: "webhook", entityId: id, action: "deleted", actor, before, after: null }),
          ]),
        );
      }),

      test: Effect.fn("WebhookService.test")(function* (id) {
        const row = yield* load(id);
        return yield* deliver(row, { event: "ping", data: { webhook: { id: row.id, name: row.name } } }, new Map());
      }),
    };
  }),
);

export const WebhookDispatcherLive = Layer.effect(
  WebhookDispatcher,
  Effect.gen(function* () {
    const { database, environmentNames, deliver } = yield* makeDelivery;
    const background = yield* BackgroundTasks;

    return {
      emit: (event, data) =>
        background.run(
          Effect.gen(function* () {
            const rows = yield* database.run("webhooks.enabled", (db) => db.query.webhooks.findMany({ where: { enabled: true } }));
            const targets = rows.filter((row) => toWebhook(row).events.includes(event));
            if (targets.length === 0) return;
            const names = yield* environmentNames;
            const message = { event, data } as WebhookMessage;
            yield* Effect.forEach(
              targets,
              (row) =>
                deliver(row, message, names).pipe(
                  Effect.catchCause((cause) => Effect.logError(`Webhook "${row.name}" delivery failed`, cause)),
                ),
              { concurrency: "unbounded", discard: true },
            );
          }).pipe(Effect.catchCause((cause) => Effect.logError(`Webhook dispatch of ${event} failed`, cause))),
        ),
    };
  }),
);
