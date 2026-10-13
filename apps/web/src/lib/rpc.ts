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

/** A message safe to show in the UI for any thrown API / network error */
export const errorMessage = (error: unknown): string => {
  if (error instanceof ORPCError) return error.message || i18n.t("common:errors.requestFailed");
  if (error instanceof TypeError) return i18n.t("common:errors.network");
  return error instanceof Error ? error.message : String(error);
};

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ORPCError && error.code === "UNAUTHORIZED";

export { isDefinedError };
