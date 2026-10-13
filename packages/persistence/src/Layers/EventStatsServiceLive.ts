import { EventStatsService } from "@furca/core/analysis/Analysis";
import { Database } from "@furca/database/Database";
import { events, exposures } from "@furca/database/schema/index";
import { and, count, desc, eq, gte, lt, max, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const EventStatsServiceLive = Layer.effect(
  EventStatsService,
  Effect.gen(function* () {
    const database = yield* Database;
    return {
      // ponytail: GROUP BY over 30 days of events (events_ts_idx range); pre-aggregate if event volume gets large
      names: (environmentId) =>
        database
          .run("events.names", (db) =>
            db
              .select({ name: events.name, count: count(), lastSeen: max(events.ts) })
              .from(events)
              .where(and(eq(events.environmentId, environmentId), gte(events.ts, Date.now() - 30 * DAY_MS)))
              .groupBy(events.name)
              .orderBy(desc(count()), events.name)
              .limit(200),
          )
          .pipe(Effect.map((rows) => rows.map((r) => ({ name: r.name, count: r.count, lastSeenAt: new Date(r.lastSeen ?? 0) })))),

      volume: Effect.fn("EventStatsService.volume")(function* (environmentId: string) {
        const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + HOUR_MS;
        const start = end - DAY_MS;
        // integer division; a bound JS number would arrive as REAL and make it a float division
        const hourly = (column: typeof events.ts | typeof exposures.firstSeenAt) => sql<number>`${column} / 3600000`;
        const [eventRows, exposureRows] = yield* database.run("events.volume", (db) =>
          db.batch([
            db
              .select({ hour: hourly(events.ts), n: count() })
              .from(events)
              .where(and(eq(events.environmentId, environmentId), gte(events.ts, start), lt(events.ts, end)))
              .groupBy(hourly(events.ts)),
            // exposures_time_idx (environment_id, first_seen_at)
            db
              .select({ hour: hourly(exposures.firstSeenAt), n: count() })
              .from(exposures)
              .where(
                and(eq(exposures.environmentId, environmentId), gte(exposures.firstSeenAt, start), lt(exposures.firstSeenAt, end)),
              )
              .groupBy(hourly(exposures.firstSeenAt)),
          ]),
        );
        const byHour = (rows: ReadonlyArray<{ hour: number; n: number }>) => new Map(rows.map((r) => [Number(r.hour), r.n]));
        const eventCounts = byHour(eventRows);
        const exposureCounts = byHour(exposureRows);
        return Array.from({ length: 24 }, (_, i) => {
          const h = start / HOUR_MS + i;
          return { hour: new Date(h * HOUR_MS), exposures: exposureCounts.get(h) ?? 0, events: eventCounts.get(h) ?? 0 };
        });
      }),
    };
  }),
);
