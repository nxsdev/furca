import "@orpc/experimental-effect/extensions/effect";
import { user } from "@kuji/database/schema/index";
import { makeDrizzle } from "@kuji/database/Database";
import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement, ORPCError } from "@orpc/server";
import { contract } from "../contract";
import type { Auth } from "./Auth";
import type { KujiEnv } from "./Env";
import type { AppServices } from "./Services";

/** oRPC context of every request. Effect handlers get AppServices through `effect/context` */
export interface RequestContext extends WithEffectContext<AppServices> {
  readonly headers: Headers;
  readonly env: KujiEnv;
  readonly auth: Auth;
}

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  /** The first account ever created */
  readonly isOwner: boolean;
}

const errorStatus = {
  NotFoundError: "NOT_FOUND",
  ValidationError: "BAD_REQUEST",
  WarehouseError: "BAD_GATEWAY",
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

/** Procedures that need no session (setup status, invitation lookup) */
export const pub = implement(contract)
  .$context<RequestContext>()
  .use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      throw toORPCError(error);
    }
  });

/** Procedures that require a Better Auth session; adds `context.user` */
export const authed = pub.use(async ({ context, next }) => {
  const session = await context.auth.api.getSession({ headers: context.headers });
  if (session === null) throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
  const [first] = await makeDrizzle(context.env.DB).select({ id: user.id }).from(user).orderBy(user.createdAt).limit(1);
  const current: CurrentUser = {
    id: session.user.id,
    email: session.user.email,
    isOwner: first?.id === session.user.id,
  };
  return next({ context: { user: current } });
});
