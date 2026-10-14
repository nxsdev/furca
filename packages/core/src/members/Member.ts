import { Schema } from "effect";

/**
 * owner: the first account; implicit admin that cannot be removed or demoted.
 * admin: everything, incl. environments, data sources, API keys, webhooks, members and approving reviews.
 * editor: flags, experiments, metrics, saved groups, namespaces; can request reviews.
 * viewer: read only
 */
export const Role = Schema.Literals(["owner", "admin", "editor", "viewer"]);
export type Role = typeof Role.Type;

/** Roles that can be granted (the owner is only ever the first account) */
export const AssignableRole = Schema.Literals(["admin", "editor", "viewer"]);
export type AssignableRole = typeof AssignableRole.Type;

const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/** True when `role` is at least `required` (owner > admin > editor > viewer) */
export const hasRole = (role: Role, required: Role): boolean => rank[role] >= rank[required];

export class Member extends Schema.Class<Member>("Member")({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Role,
  createdAt: Schema.Date,
}) {}

export class Invitation extends Schema.Class<Invitation>("Invitation")({
  id: Schema.String,
  email: Schema.String,
  /** Role the account gets when signing up through this invitation */
  role: AssignableRole,
  /** Sign-up URL path containing the one-time token */
  url: Schema.String,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
}) {}
