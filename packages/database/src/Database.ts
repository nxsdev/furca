import { PersistenceError } from "@furca/core/shared/errors";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context, Effect, Layer } from "effect";
import { authRelations } from "./schema/auth";
import * as schema from "./schema/index";

const { authRelations: _authRelations, ...tables } = schema;

/** Drizzle RQB v2 relations: app tables have none (aggregates keep children in JSON columns) */
export const relations = { ...defineRelations(tables), ...authRelations };

export const makeDrizzle = (d1: D1Database) => drizzle(d1, { relations });
export type Db = ReturnType<typeof makeDrizzle>;

export interface DatabaseShape {
  /** Drizzle client for D1. Use `run` to turn its promises into Effects */
  readonly db: Db;
  /** Raw D1 binding, for analysis SQL that Drizzle cannot express */
  readonly d1: D1Database;
  /**
   * Runs a Drizzle query and maps failures to PersistenceError.
   * D1 has no interactive transactions: use `db.batch([...])` inside for atomic multi-statement writes
   */
  readonly run: <A>(operation: string, query: (db: Db) => Promise<A>) => Effect.Effect<A, PersistenceError>;
}

export class Database extends Context.Service<Database, DatabaseShape>()("furca/Database") {}

export const makeDatabase = (d1: D1Database): DatabaseShape => {
  const db = makeDrizzle(d1);
  return {
    db,
    d1,
    run: (operation, query) =>
      Effect.tryPromise({
        try: () => query(db),
        catch: (cause) => new PersistenceError({ operation, cause }),
      }).pipe(Effect.withSpan(`db.${operation}`)),
  };
};

export const DatabaseLive = (d1: D1Database) => Layer.succeed(Database, makeDatabase(d1));
