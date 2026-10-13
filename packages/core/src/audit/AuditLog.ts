import { Schema } from "effect";

export const AuditEntityType = Schema.Literals([
  "feature",
  "experiment",
  "metric",
  "datasource",
  "environment",
  "member",
]);
export type AuditEntityType = typeof AuditEntityType.Type;

/** Append-only record of a change. before/after are JSON snapshots of the entity */
export class AuditLog extends Schema.Class<AuditLog>("AuditLog")({
  id: Schema.String,
  entityType: AuditEntityType,
  entityId: Schema.String,
  /** Short verb, e.g. created, updated, rules.updated, started, phase.started, stopped */
  action: Schema.String,
  actorId: Schema.String,
  actorEmail: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
}) {}
