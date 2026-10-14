import { hasRole, type Role } from "@furca/core/members/Member";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "./rpc";

/**
 * What the signed-in member may do, so write controls can be hidden instead of failing. The API
 * enforces the same rules (procedureAccess in packages/api/src/Runtime/orpc.ts)
 */
export function usePermissions() {
  // Same query as the app shell, so this never fetches on its own
  const { data: me } = useQuery({ ...orpc.session.me.queryOptions(), retry: false, staleTime: 60_000 });
  const role: Role = me?.role ?? "viewer";
  return { me, role, canEdit: hasRole(role, "editor"), isAdmin: hasRole(role, "admin") };
}
