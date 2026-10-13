/** Helpers shared by the *ServiceLive layers */
import type { Actor, AuditEntityType } from "@kuji/core/audit/AuditLog";
import type { Feature } from "@kuji/core/features/Feature";
import { NotFoundError, type PersistenceError, ValidationError } from "@kuji/core/shared/errors";
import type { DatabaseShape, Db } from "@kuji/database/Database";
import { auditLogs } from "@kuji/database/schema/index";
import { Effect } from "effect";
import { toFeature } from "./mappers";

export const newId = () => crypto.randomUUID();

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export const invalid = (message: string) => Effect.fail(new ValidationError({ message }));

export type BatchItem = Parameters<Db["batch"]>[0][number];

/** db.batch for a dynamic list: one atomic D1 round trip (D1 has no interactive transactions) */
export const batch = (db: Db, items: ReadonlyArray<BatchItem>): Promise<unknown> =>
  items.length === 0 ? Promise.resolve() : db.batch(items as [BatchItem, ...BatchItem[]]);

/** Splits rows so one INSERT stays under D1's 100 bound parameters */
export const chunk = <A>(rows: ReadonlyArray<A>, columns: number): Array<ReadonlyArray<A>> => {
  const size = Math.floor(100 / columns);
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

/** Audit row insert, meant to go into the same batch as the change it records */
export const auditInsert = (
  db: Db,
  entry: {
    readonly entityType: AuditEntityType;
    readonly entityId: string;
    readonly action: string;
    readonly actor: Actor;
    readonly before: unknown;
    readonly after: unknown;
  },
) =>
  db.insert(auditLogs).values({
    id: newId(),
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    actorId: entry.actor.id,
    actorEmail: entry.actor.email,
    before: entry.before == null ? null : JSON.stringify(entry.before),
    after: entry.after == null ? null : JSON.stringify(entry.after),
    createdAt: new Date(),
  });

/** Features with their environment rows (ordered like the environments), by key */
export const loadFeatures = (database: DatabaseShape, filter: { readonly id?: string; readonly includeArchived: boolean }) =>
  database.run("features.load", async (db) => {
    const [rows, envRows, envs] = await Promise.all([
      db.query.features.findMany({
        where: { id: filter.id, archivedAt: filter.includeArchived ? undefined : { isNull: true } },
        orderBy: { key: "asc" },
      }),
      db.query.featureEnvironments.findMany({ where: { featureId: filter.id } }),
      db.query.environments.findMany({ orderBy: { sortOrder: "asc" } }),
    ]);
    const order = new Map(envs.map((e, i) => [e.id, i]));
    envRows.sort((a, b) => (order.get(a.environmentId) ?? 0) - (order.get(b.environmentId) ?? 0));
    const byFeature = new Map<string, typeof envRows>();
    for (const r of envRows) byFeature.set(r.featureId, [...(byFeature.get(r.featureId) ?? []), r]);
    return rows.map((r) => toFeature(r, byFeature.get(r.id) ?? []));
  });

export const getFeature = (database: DatabaseShape, id: string): Effect.Effect<Feature, NotFoundError | PersistenceError> =>
  loadFeatures(database, { id, includeArchived: true }).pipe(
    Effect.flatMap(([feature]) => (feature ? Effect.succeed(feature) : Effect.fail(new NotFoundError({ entity: "feature", id })))),
  );
