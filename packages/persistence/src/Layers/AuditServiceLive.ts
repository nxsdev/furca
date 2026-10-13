import { AuditLog, AuditEntityType } from "@kuji/core/audit/AuditLog";
import { AuditService } from "@kuji/core/audit/AuditService";
import { Database } from "@kuji/database/Database";
import { Effect, Layer, Schema } from "effect";

const entityType = Schema.decodeUnknownSync(AuditEntityType);

export const AuditServiceLive = Layer.effect(
  AuditService,
  Effect.gen(function* () {
    const database = yield* Database;
    return {
      // ponytail: entries sharing the cursor's millisecond are skipped; add an id tiebreaker if that ever matters
      list: (query) =>
        database
          .run("audit.list", (db) =>
            db.query.auditLogs.findMany({
              where: {
                entityType: query.entityType ?? undefined,
                entityId: query.entityId ?? undefined,
                createdAt: query.before === null ? undefined : { lt: query.before },
              },
              orderBy: { createdAt: "desc", id: "desc" },
              limit: query.limit,
            }),
          )
          .pipe(Effect.map((rows) => rows.map((r) => AuditLog.make({ ...r, entityType: entityType(r.entityType) })))),
    };
  }),
);
