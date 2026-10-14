import "@orpc/experimental-effect/extensions/effect";
import { hasRole, Role } from "@furca/core/members/Member";
import type { ApiKeyRole } from "@furca/core/platform/ApiKey";
import { ApiKeyService } from "@furca/core/platform/ApiKeyService";
import { type ErrorCode, issue, type NotFoundError, type ValidationError } from "@furca/core/shared/errors";
import { runPromise, type WithEffectContext } from "@orpc/experimental-effect";
import { implement, ORPCError } from "@orpc/server";
import { Effect, Schema } from "effect";
import { contract, type FurcaContract } from "../contract";
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
  /** API keys: admin keys act as admin, readonly keys as viewer */
  readonly role: Role;
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
  ForbiddenError: "FORBIDDEN",
} as const;

/**
 * oRPC error with the English `message` (API clients, logs) and, when the error has a code,
 * `data: { code, params, field }`: the admin UI translates the code and shows it under `field`
 */
export const orpcError = (status: string, { message, code, params, field }: Pick<ValidationError, "message" | "code" | "params" | "field">) =>
  new ORPCError(status, { message, data: code === undefined ? undefined : { code, params, field } });

/**
 * Domain errors (core/shared/errors) thrown out of Effect handlers become typed oRPC errors.
 * PersistenceError and unknown failures are logged and hidden behind INTERNAL_SERVER_ERROR
 */
export const toORPCError = (error: unknown): ORPCError<string, unknown> => {
  if (error instanceof ORPCError) return error;
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";
  if (tag === "NotFoundError") return orpcError("NOT_FOUND", issue(`notFound.${(error as NotFoundError).entity}`));
  if (tag in errorStatus) return orpcError(errorStatus[tag as keyof typeof errorStatus], error as ValidationError);
  console.error("Unhandled API error", error);
  return orpcError("INTERNAL_SERVER_ERROR", issue("common.unexpected"));
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

/** read: every member and readonly API keys; editor: editors and up; admin: admins and the owner */
export type Access = "read" | "editor" | "admin";

/**
 * Who may call each procedure. Every contract procedure (except `public`) must be listed: the type
 * requires it and a test checks it; anything unlisted at runtime is admin-only
 */
export const procedureAccess: {
  readonly [D in Exclude<keyof FurcaContract, "public">]: { readonly [P in keyof FurcaContract[D]]: Access };
} = {
  session: { me: "read" },
  environments: {
    list: "read",
    payload: "read",
    create: "admin",
    update: "admin",
    rotateSdkKey: "admin",
    setRequireApproval: "admin",
    delete: "admin",
  },
  features: {
    list: "read",
    get: "read",
    create: "editor",
    update: "editor",
    setEnabled: "editor",
    saveRules: "editor",
    archive: "editor",
    delete: "editor",
  },
  experiments: {
    list: "read",
    get: "read",
    create: "editor",
    update: "editor",
    start: "editor",
    updateTraffic: "editor",
    stop: "editor",
    archive: "editor",
    delete: "editor",
  },
  metrics: { list: "read", get: "read", create: "editor", update: "editor", archive: "editor", baseline: "read" },
  dataSources: { list: "read", get: "read", create: "admin", update: "admin", delete: "admin", test: "admin" },
  results: { latest: "read", dimension: "read", refresh: "editor" },
  events: { names: "read", properties: "read", volume: "read" },
  audit: { list: "read" },
  savedGroups: { list: "read", get: "read", create: "editor", update: "editor", delete: "editor" },
  namespaces: { list: "read", create: "editor", update: "editor", delete: "editor" },
  apiKeys: { list: "admin", create: "admin", revoke: "admin" },
  webhooks: { list: "admin", create: "admin", update: "admin", delete: "admin", test: "admin" },
  members: { list: "read", invite: "admin", revokeInvitation: "admin", setRole: "admin", remove: "admin" },
  // cancel: editors only cancel their own requests (checked in the handler)
  changeRequests: { list: "read", get: "read", create: "editor", approve: "admin", reject: "admin", cancel: "editor" },
};

export const accessOf = (path: ReadonlyArray<string>): Access =>
  (procedureAccess as Partial<Record<string, Partial<Record<string, Access>>>>)[path[0] ?? ""]?.[path[1] ?? ""] ?? "admin";

const requiredRole = { read: "viewer", editor: "editor", admin: "admin" } as const satisfies Record<Access, Role>;

const adminOnly: Partial<Record<string, ErrorCode>> = {
  environments: "access.environments",
  dataSources: "access.dataSources",
  apiKeys: "access.apiKeys",
  webhooks: "access.webhooks",
  members: "access.members",
  changeRequests: "access.changeRequests",
};

const authenticate = async (
  context: RequestContext,
): Promise<{ readonly user: CurrentUser; readonly apiKey: RequestApiKey | null }> => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(context.headers.get("authorization") ?? "")?.[1];
  if (bearer !== undefined) {
    const key = await runPromise(ApiKeyService.use((s) => s.authenticate(bearer)).pipe(Effect.provide(context["effect/context"])));
    if (key === null) throw orpcError("UNAUTHORIZED", issue("auth.invalidApiKey"));
    const role = key.role === "admin" ? "admin" : "viewer";
    return { user: { id: `apikey:${key.id}`, email: `api-key:${key.name}`, role }, apiKey: { id: key.id, role: key.role } };
  }
  const session = await context.auth.api.getSession({ headers: context.headers });
  if (session === null) throw orpcError("UNAUTHORIZED", issue("auth.signInRequired"));
  const role = Schema.is(Role)(session.user.role) ? session.user.role : "viewer";
  return { user: { id: session.user.id, email: session.user.email, role }, apiKey: null };
};

/**
 * Procedures that require a signed-in member: a Better Auth session cookie, or
 * `Authorization: Bearer furca_…` (an API key acts as `apikey:<id>` / `api-key:<name>` in audit logs).
 * Checks the caller's role against `procedureAccess` and adds `context.user` and `context.apiKey`
 * (null for sessions)
 */
export const authed = pub.use(async ({ context, next, path }) => {
  const { user, apiKey } = await authenticate(context);
  const access = accessOf(path);
  if (!hasRole(user.role, requiredRole[access])) {
    const code =
      apiKey?.role === "readonly"
        ? "access.readOnlyKey"
        : access === "admin"
          ? (adminOnly[path[0] ?? ""] ?? "access.adminOnly")
          : "access.viewer";
    throw orpcError("FORBIDDEN", issue(code));
  }
  return next({ context: { user, apiKey } });
});
