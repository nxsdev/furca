import "@orpc/experimental-effect/extensions/effect";
import { user } from "@furca/database/schema/index";
import { makeDrizzle } from "@furca/database/Database";
import type { ApiKeyRole } from "@furca/core/platform/ApiKey";
import { ApiKeyService } from "@furca/core/platform/ApiKeyService";
import { runPromise, type WithEffectContext } from "@orpc/experimental-effect";
import { implement, ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { contract } from "../contract";
import type { Auth } from "./Auth";
import type { FurcaEnv } from "./Env";
import type { AppServices } from "./Services";

/** oRPC context of every request. Effect handlers get AppServices through `effect/context` */
export interface RequestContext extends WithEffectContext<AppServices> {
  readonly headers: Headers;
  readonly env: FurcaEnv;
  readonly auth: Auth;
  readonly ctx: ExecutionContext;
}

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  /** The first account ever created */
  readonly isOwner: boolean;
}

/** The API key a request authenticated with */
export interface RequestApiKey {
  readonly id: string;
  readonly role: ApiKeyRole;
}

const errorStatus = {
  NotFoundError: "NOT_FOUND",
  ValidationError: "BAD_REQUEST",
  WarehouseError: "BAD_GATEWAY",
  ConflictError: "CONFLICT",
} as const;

/**
 * Domain errors (core/shared/errors) thrown out of Effect handlers become typed oRPC errors.
 * PersistenceError and unknown failures are logged and hidden behind INTERNAL_SERVER_ERROR
 */
export const toORPCError = (error: unknown): ORPCError<string, unknown> => {
  if (error instanceof ORPCError) return error;
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";
  if (tag === "NotFoundError") {
    const { entity } = error as { entity: string };
    return new ORPCError("NOT_FOUND", { message: `${entity[0]?.toUpperCase()}${entity.slice(1)} not found` });
  }
  if (tag in errorStatus) {
    return new ORPCError(errorStatus[tag as keyof typeof errorStatus], { message: (error as { message: string }).message });
  }
  console.error("Unhandled API error", error);
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: "Something went wrong. Try again." });
};

/**
 * Copies Schema.Class instances into plain objects. oRPC's serializer only walks plain objects and
 * arrays, so a Date inside a class instance would reach the browser as an untyped ISO string
 */
export const toPlain = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(toPlain);
  const plain: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) plain[key] = toPlain(v);
  return plain;
};

/** Procedures that need no session (setup status, invitation lookup) */
export const pub = implement(contract)
  .$context<RequestContext>()
  .use(async ({ next }) => {
    try {
      const result = await next();
      return { ...result, output: toPlain(result.output) as typeof result.output };
    } catch (error) {
      throw toORPCError(error);
    }
  });

/** What a readonly API key may call: the last path segment of the procedure */
const READ_PROCEDURES = new Set(["list", "get", "latest", "names", "volume", "properties", "dimension", "payload", "me"]);

const authenticate = async (
  context: RequestContext,
  path: ReadonlyArray<string>,
): Promise<{ readonly user: CurrentUser; readonly apiKey: RequestApiKey | null }> => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(context.headers.get("authorization") ?? "")?.[1];
  if (bearer !== undefined) {
    const key = await runPromise(ApiKeyService.use((s) => s.authenticate(bearer)).pipe(Effect.provide(context["effect/context"])));
    if (key === null) throw new ORPCError("UNAUTHORIZED", { message: "Invalid or revoked API key" });
    if (key.role === "readonly" && !READ_PROCEDURES.has(path.at(-1) ?? "")) {
      throw new ORPCError("FORBIDDEN", { message: "This API key is read-only" });
    }
    return { user: { id: `apikey:${key.id}`, email: `api-key:${key.name}`, isOwner: false }, apiKey: { id: key.id, role: key.role } };
  }
  const session = await context.auth.api.getSession({ headers: context.headers });
  if (session === null) throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
  const [first] = await makeDrizzle(context.env.DB).select({ id: user.id }).from(user).orderBy(user.createdAt).limit(1);
  return { user: { id: session.user.id, email: session.user.email, isOwner: first?.id === session.user.id }, apiKey: null };
};

/**
 * Procedures that require a signed-in member: a Better Auth session cookie, or
 * `Authorization: Bearer furca_…` (an API key acts as `apikey:<id>` / `api-key:<name>` in audit logs).
 * Adds `context.user` and `context.apiKey` (null for sessions)
 */
export const authed = pub.use(async ({ context, next, path }) => {
  const { user, apiKey } = await authenticate(context, path);
  return next({ context: { user, apiKey } });
});
