import type { FurcaContract } from "@furca/api/contract";
import { createORPCClient, isDefinedError, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { i18n } from "~/i18n";

const link = new RPCLink({ url: "/api/rpc" });

/** Typed admin API client: `await client.features.list({ includeArchived: false })` */
export const client: ContractRouterClient<FurcaContract> = createORPCClient(link);

/**
 * TanStack Query helpers:
 *   useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }))
 *   useMutation(orpc.features.create.mutationOptions({ onSuccess: ... }))
 *   queryClient.invalidateQueries({ queryKey: orpc.features.key() })
 */
export const orpc = createTanstackQueryUtils(client);

type Params = Readonly<Record<string, string | number>>;

/** `data` of a coded server error (api Runtime/orpc.ts `orpcError`), or undefined */
const errorData = (error: unknown): { readonly code: string; readonly params: Params; readonly field?: string } | undefined => {
  const data: unknown = error instanceof ORPCError ? error.data : undefined;
  if (typeof data !== "object" || data === null || !("code" in data) || typeof data.code !== "string") return undefined;
  const params = "params" in data && typeof data.params === "object" && data.params !== null ? (data.params as Params) : {};
  const field = "field" in data && typeof data.field === "string" ? data.field : undefined;
  return { code: data.code, params, field };
};

/** The form field a server error belongs to, if it names one */
export const errorField = (error: unknown): string | undefined => errorData(error)?.field;

/** errors:<code> in the current language; a `reason` param is itself a code (`Rule 2: Expected a number`) */
const translate = (code: string, { reason, ...params }: Params): string =>
  i18n.t(`errors:${code}` as "errors:common.unexpected", {
    ...params,
    ...(typeof reason === "string" ? { reason: translate(reason, params) } : {}),
  });

/**
 * A message safe to show in the UI for any thrown API / network error: coded server errors in the
 * user's language, anything else (an unknown code from a newer server, plain errors) as sent
 */
export const errorMessage = (error: unknown): string => {
  const data = errorData(error);
  if (data !== undefined && i18n.exists(`errors:${data.code}`)) return translate(data.code, data.params);
  if (error instanceof ORPCError) return error.message || i18n.t("common:errors.requestFailed");
  if (error instanceof TypeError) return i18n.t("common:errors.network");
  return error instanceof Error ? error.message : String(error);
};

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ORPCError && error.code === "UNAUTHORIZED";

export { isDefinedError };
