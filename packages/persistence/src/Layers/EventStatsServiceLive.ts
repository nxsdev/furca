import { EventStatsService } from "@furca/core/analysis/Analysis";
import type { EventSource } from "@furca/core/metrics/Metric";
import { Database } from "@furca/database/Database";
import { events, exposures } from "@furca/database/schema/index";
import { and, count, desc, eq, gte, lt, max, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { d1BaselineSql } from "./AnalysisSql";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Property keys of one event with their event counts and 10 most frequent values. Values read as
 * text like the metric filters compare them (booleans "true" / "false")
 */
const PROPERTIES_SQL = `WITH props AS (
    SELECT j.key AS property,
      CASE j.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(j.value AS TEXT) END AS value
    FROM events e, json_each(e.properties) j
    WHERE e.environment_id = ?1 AND e.name = ?2 AND e.ts >= ?3 AND e.properties IS NOT NULL
  ),
  top_keys AS (SELECT property, COUNT(*) AS n FROM props GROUP BY property ORDER BY n DESC, property LIMIT 50),
  top_values AS (
    SELECT property, value, ROW_NUMBER() OVER (PARTITION BY property ORDER BY COUNT(*) DESC, value) AS rank
    FROM props WHERE property IN (SELECT property FROM top_keys) AND value IS NOT NULL
    GROUP BY property, value
  )
SELECT k.property, k.n, v.value FROM top_keys k LEFT JOIN top_values v ON v.property = k.property AND v.rank <= 10
ORDER BY k.n DESC, k.property, v.rank`;

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

      // ponytail: json_each over 30 days of one event (events_name_user_ts_idx prefix); pre-aggregate if it gets slow
      properties: Effect.fn("EventStatsService.properties")(function* (environmentId: string, event: string) {
        const rows = yield* database.run("events.properties", () =>
          database.d1
            .prepare(PROPERTIES_SQL)
            .bind(environmentId, event, Date.now() - 30 * DAY_MS)
            .all<{ property: string; n: number; value: string | null }>()
            .then((r) => r.results),
        );
        const stats = new Map<string, { property: string; count: number; sampleValues: string[] }>();
        for (const r of rows) {
          const stat = stats.get(r.property) ?? { property: r.property, count: r.n, sampleValues: [] };
          if (r.value !== null) stat.sampleValues.push(r.value);
          stats.set(r.property, stat);
        }
        return [...stats.values()];
      }),

      // ponytail: one scan of `days` of events (events_ts_idx) per planner open; fine for D1's sizes
      baseline: Effect.fn("EventStatsService.baseline")(function* (
        environmentId: string,
        metric: { readonly type: "proportion" | "mean"; readonly source: EventSource },
        days: number,
      ) {
        const span = Math.min(90, Math.max(1, Math.round(days)));
        const now = Date.now();
        const q = d1BaselineSql({ environmentId, sinceMs: now - span * DAY_MS, source: metric.source });
        const row = yield* database.run("events.baseline", () =>
          database.d1
            .prepare(q.sql)
            .bind(...q.params)
            .first<{ n: number; converted: number; sum_y: number; sum_y2: number; first_ts: number | null }>(),
        );
        if (row === null || row.n === 0) return null;
        // A store younger than the window has fewer days of traffic: divide by the days actually seen
        const seen = row.first_ts === null ? span : Math.min(span, Math.max(1, Math.round((now - row.first_ts) / DAY_MS)));
        const mean = row.sum_y / row.n;
        const variance = row.n > 1 ? Math.max(0, (row.sum_y2 - row.n * mean * mean) / (row.n - 1)) : 0;
        const proportion = metric.type === "proportion";
        return {
          days: seen,
          users: row.n,
          dailyUsers: row.n / seen,
          rate: proportion ? row.converted / row.n : null,
          mean: proportion ? null : mean,
          stdDev: proportion ? null : Math.sqrt(variance),
        };
      }),

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
