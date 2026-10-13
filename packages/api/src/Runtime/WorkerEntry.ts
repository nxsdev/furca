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

/** Builds every Effect service for this request (Workers bindings are per request) */
const buildServices = (env: FurcaEnv) => Effect.runSync(Layer.build(makeAppLayer(env)).pipe(Effect.scoped));

/** Routes every /api/* request. Called from apps/web/src/server.ts */
export const handleApiRequest = async (request: Request, env: FurcaEnv, ctx: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/sdk/")) return handleSdkRequest(request, env, ctx);
  const auth = createAuth(env, url.origin);
  if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
  if (url.pathname.startsWith("/api/rpc")) {
    const { matched, response } = await rpcHandler.handle(request, {
      prefix: "/api/rpc",
      context: { headers: request.headers, env, auth, "effect/context": buildServices(env) },
    });
    if (matched) return response;
  }
  return Response.json({ error: "Not found" }, { status: 404 });
};

/** Cron trigger entry */
export const runScheduled = (_controller: ScheduledController, env: FurcaEnv): Promise<void> => runScheduledAnalysis(env);
