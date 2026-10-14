import { hasRole } from "@furca/core/members/Member";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "./rpc";

/** Members (shared query with Settings), their display names and how many of them can approve reviews */
export function useMembers() {
  const { data } = useQuery({ ...orpc.members.list.queryOptions(), staleTime: 60_000 });
  const names = new Map((data?.members ?? []).map((m) => [m.email, m.name.trim()]));
  return {
    /** Name for an email, or the email itself (API keys, removed members, members without a name) */
    nameOf: (email: string) => names.get(email) || email,
    /** Owners and admins; null while loading */
    adminCount: data === undefined ? null : data.members.filter((m) => hasRole(m.role, "admin")).length,
  };
}

/** A member's name, with the email on hover */
export function MemberName({ email, className }: { email: string; className?: string }) {
  const { nameOf } = useMembers();
  const name = nameOf(email);
  return (
    <span title={name === email ? undefined : email} className={className}>
      {name}
    </span>
  );
}
