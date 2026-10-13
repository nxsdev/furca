import { SdkService } from "@kuji/core/environments/SdkService";
import type { NotFoundError, PersistenceError } from "@kuji/core/shared/errors";
import { isbot } from "isbot";
import { Cause, Effect, Schema } from "effect";
import type { KujiEnv } from "../Runtime/Env";
import { makeAppLayer } from "../Runtime/Services";

/**
 * Public SDK endpoints (CORS *, no session):
 *   GET  /api/sdk/v1/payload/:sdkKey  -> SdkPayload JSON from KV (built and published on a miss)
 *   POST /api/sdk/v1/events/:sdkKey   -> EventsBody (any content type, parsed as JSON), 202 { accepted }
 */

const MAX_ITEMS = 500;
const MAX_BODY_BYTES = 1_000_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status: number) => Response.json(body, { status, headers: CORS });

const Text = Schema.String.check(Schema.isMaxLength(256));

/** EventsBody from @kuji/sdk/types */
const EventsBody = Schema.Struct({
  exposures: Schema.optional(
    Schema.Array(
      Schema.Struct({
        experimentKey: Text,
        variationKey: Text,
        phase: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        userId: Text,
        ts: Schema.Finite,
      }),
    ),
  ),
  events: Schema.optional(
    Schema.Array(Schema.Struct({ name: Text, userId: Text, value: Schema.optional(Schema.NullOr(Schema.Finite)), ts: Schema.Finite })),
  ),
});
const decodeEventsBody = Schema.decodeUnknownExit(EventsBody);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Runs an SDK program with the app services; unknown SDK keys become 404, anything else a logged 500 */
const run = (env: KujiEnv, program: Effect.Effect<Response, NotFoundError | PersistenceError, SdkService>) =>
  Effect.runPromise(
    program.pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed(json({ error: "Unknown SDK key" }, 404))),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error("SDK endpoint failed", Cause.pretty(cause));
          return json({ error: "Internal error" }, 500);
        }),
      ),
      Effect.provide(makeAppLayer(env)),
    ),
  );

const payload = (env: KujiEnv, sdkKey: string) =>
  run(
    env,
    Effect.gen(function* () {
      const body = yield* (yield* SdkService).payload(sdkKey);
      return new Response(body, {
        headers: {
          ...CORS,
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=30, stale-while-revalidate=300",
        },
      });
    }),
  );

const ingest = async (request: Request, env: KujiEnv, sdkKey: string): Promise<Response> => {
  // Bot filtering applies to browser traffic only: server-side SDKs (Node, Bun) send their runtime's
  // user agent, which isbot flags, and the end user's agent is unknown there
  const fromBrowser = request.headers.has("sec-fetch-site") || request.headers.has("origin");
  if (fromBrowser && isbot(request.headers.get("user-agent"))) return json({ accepted: 0 }, 202);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "Body too large" }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "Body too large" }, 413);
  const decoded = decodeEventsBody(parseJson(text));
  if (decoded._tag === "Failure") return json({ error: "Invalid events body" }, 400);
  // SDKs before phase support send no phase: their exposures belong to phase 0
  const exposures = (decoded.value.exposures ?? []).map((e) => ({ ...e, phase: e.phase ?? 0 }));
  const events = (decoded.value.events ?? []).map((e) => ({ ...e, value: e.value ?? null }));
  if (exposures.length + events.length > MAX_ITEMS) return json({ error: `At most ${MAX_ITEMS} items per request` }, 413);
  return run(
    env,
    Effect.gen(function* () {
      const accepted = yield* (yield* SdkService).ingest(sdkKey, { exposures, events });
      return json({ accepted }, 202);
    }),
  );
};

export const handleSdkRequest = async (request: Request, env: KujiEnv, _ctx: ExecutionContext): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const match = /^\/api\/sdk\/v1\/(payload|events)\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (match === null) return json({ error: "Not found" }, 404);
  // SDK keys are sdk-<hex>: nothing to URL-decode
  const [, route, sdkKey = ""] = match;
  if (route === "payload" && (request.method === "GET" || request.method === "HEAD")) return payload(env, sdkKey);
  if (route === "events" && request.method === "POST") return ingest(request, env, sdkKey);
  return json({ error: "Method not allowed" }, 405);
};
