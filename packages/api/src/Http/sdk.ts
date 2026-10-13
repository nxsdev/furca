import type { KujiEnv } from "../Runtime/Env";

/**
 * Public SDK endpoints (CORS *, no session):
 *   GET  /api/sdk/v1/payload/:sdkKey  -> SdkPayload JSON from KV
 *   POST /api/sdk/v1/events/:sdkKey   -> EventsBody (application/json or text/plain), 202
 * TODO(backend): implement
 */
export const handleSdkRequest = async (_request: Request, _env: KujiEnv, _ctx: ExecutionContext): Promise<Response> =>
  Response.json({ error: "Not implemented" }, { status: 501 });
