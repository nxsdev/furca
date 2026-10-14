import { EffectSchemaToJsonSchemaConverter } from "@orpc/experimental-effect";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { handleSdkRequest } from "../Http/sdk";
import { Effect, Layer } from "effect";
import { createAuth } from "./Auth";
import type { FurcaEnv } from "./Env";
import { router } from "./router";
import { runScheduledAnalysis } from "./Scheduled";
import { makeAppLayer } from "./Services";

export type { FurcaEnv } from "./Env";

const rpcHandler = new RPCHandler(router);

/** The REST surface: everything an API key can call (no setup / session procedures) */
const { public: _public, session: _session, ...restRouter } = router;
const restHandler = new OpenAPIHandler(restRouter);

let openApiSpec: Promise<object> | undefined;
/** OpenAPI 3.1 document of /api/v1, generated once per isolate */
const openApiDocument = () =>
  (openApiSpec ??= new OpenAPIGenerator({ converters: [new EffectSchemaToJsonSchemaConverter()] }).generate(restRouter, {
    version: "3.1.1",
    base: {
      info: {
        title: "furca API",
        version: "1",
        description:
          "Admin API of furca. Every operation is `POST /api/v1/<area>/<operation>` with a JSON body. " +
          "Authenticate with an API key from Settings > API keys: `Authorization: Bearer furca_…`",
      },
      components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "furca API key (furca_…)" } } },
      security: [{ apiKey: [] }],
    },
  }));

/** Builds every Effect service for this request (Workers bindings are per request) */
const buildServices = (env: FurcaEnv, ctx: ExecutionContext) =>
  Effect.runSync(Layer.build(makeAppLayer(env, ctx)).pipe(Effect.scoped));

/** Routes every /api/* request. Called from apps/web/src/server.ts */
export const handleApiRequest = async (request: Request, env: FurcaEnv, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/sdk/")) return handleSdkRequest(request, env, ctx);
  const auth = createAuth(env, url.origin);
  if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
  if (url.pathname.startsWith("/api/rpc")) {
    const { matched, response } = await rpcHandler.handle(request, {
      prefix: "/api/rpc",
      context: { headers: request.headers, env, auth, ctx, "effect/context": buildServices(env, ctx) },
    });
    if (matched) return response;
  }
  if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
    return Response.json({ ...(await openApiDocument()), servers: [{ url: `${url.origin}/api/v1` }] });
  }
  if (url.pathname.startsWith("/api/v1/")) {
    // API keys only: without the cookie a browser session can never authorize a cross-site request (CSRF-safe)
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    const { matched, response } = await restHandler.handle(request, {
      prefix: "/api/v1",
      context: { headers, env, auth, ctx, "effect/context": buildServices(env, ctx) },
    });
    if (matched) return response;
  }
  return Response.json({ error: "Not found" }, { status: 404 });
};

/** Cron trigger entry */
export const runScheduled = (_controller: ScheduledController, env: FurcaEnv): Promise<void> => runScheduledAnalysis(env);
