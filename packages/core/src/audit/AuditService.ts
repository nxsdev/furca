import { Context, type Effect } from "effect";
import type { PersistenceError } from "../shared/errors";
import type { AuditEntityType, AuditLog } from "./AuditLog";

export interface AuditQuery {
  readonly entityType: AuditEntityType | null;
  readonly entityId: string | null;
  /** Entries strictly older than this */
  readonly before: Date | null;
  readonly limit: number;
}

/** Reads the audit log. Rows are appended by each service in the same D1 batch as the change */
export interface AuditServiceShape {
  /** Newest first */
  readonly list: (query: AuditQuery) => Effect.Effect<ReadonlyArray<AuditLog>, PersistenceError>;
}

export class AuditService extends Context.Service<AuditService, AuditServiceShape>()("furca/AuditService") {}
