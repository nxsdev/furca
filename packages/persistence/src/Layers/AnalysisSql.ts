/**
 * Experiment analysis SQL for the built-in store (D1 / SQLite) and BigQuery. Both dialects implement
 * the same semantics and return the same columns, so the stats pipeline does not care which ran:
 *
 * - Units: exposures of the experiment key within [start, end]. Per unit: first exposure t0 and
 *   variation. A unit seen in 2+ variations is a multiple exposure: counted, then excluded.
 *   D1 also filters on the phase index (exposures are stored first-seen per phase, so a unit
 *   re-randomized by a new phase counts again). BigQuery exposure SQL returns view events, so the
 *   phase's time window is what separates phases there
 * - Per-unit value y from the metric's events with t0 + delay <= ts < t0 + window (no upper bound
 *   without a window) and ts <= end. proportion: 1 if any event; mean: count / sum; ratio: numerator y
 *   and denominator d. Units without events are 0
 * - CUPED covariate x: the same value over [t0 - 14 days, t0) (not for ratio metrics)
 * - Capping on per-unit y and x, never on raw events: absolute min(v, cap), or the p-quantile of y
 *   pooled across variations (D1: nearest rank floor(p·(n−1)); BigQuery: APPROX_QUANTILES, 0.1% grid).
 *   Not applied to proportion metrics (values are 0/1). Ratio metrics cap the numerator only
 *
 * Exposure counts columns: variation (NULL = multiple exposure), users
 * Moments columns: variation, day (UTC date of t0, YYYY-MM-DD), n, sum_y, sum_y2, sum_d, sum_d2,
 * sum_yd, sum_x, sum_x2, sum_xy, cap_value
 *
 * User input is always a bound parameter. The only interpolated text is warehouse SQL written by
 * admins (data source exposure SQL, metric SQL), which is the point of a warehouse-native source
 */
import type { EventSource, Metric } from "@kuji/core/metrics/Metric";

const HOUR_MS = 3_600_000;
export const LOOKBACK_MS = 14 * 24 * HOUR_MS;

export interface AnalysisWindow {
  readonly experimentKey: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface MomentsOptions extends AnalysisWindow {
  readonly metric: Metric;
  /** Compute the pre-exposure covariate (ignored for ratio metrics) */
  readonly cuped: boolean;
}

const plan = ({ metric, cuped }: MomentsOptions) => ({
  ratio: metric.type === "ratio",
  pre: cuped && metric.type !== "ratio",
  delayMs: Math.round(metric.delayHours * HOUR_MS),
  windowMs: metric.windowHours === null ? null : Math.round(metric.windowHours * HOUR_MS),
  capping: metric.type === "proportion" ? ({ type: "none" } as const) : metric.capping,
});

// ---------------------------------------------------------------------------------------------
// D1 (SQLite). Correlated subqueries per unit hit events_name_user_ts_idx (env, name, user, ts)

/** Built-in store scope: exposures and events of one environment, exposures of one phase */
interface D1Scope {
  readonly environmentId: string;
  readonly phase: number;
}

export interface D1Query {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number>;
}

/** Numbered placeholders (?1, ?2, ...) so one value can be referenced many times */
const sqliteParams = () => {
  const params: Array<string | number> = [];
  return { params, p: (v: string | number) => `?${params.push(v)}` };
};

/** Uses the primary key (environment_id, experiment_key, phase, user_id, variation_key) */
const d1Units = (env: string, key: string, phase: string, start: string, end: string) => `units AS (
    SELECT user_id, MIN(variation_key) AS variation, COUNT(*) AS nv, MIN(first_seen_at) AS t0
    FROM exposures
    WHERE environment_id = ${env} AND experiment_key = ${key} AND phase = ${phase}
      AND first_seen_at >= ${start} AND first_seen_at <= ${end}
    GROUP BY user_id
  )`;

export const d1ExposureCountsSql = (q: AnalysisWindow & D1Scope): D1Query => {
  const { params, p } = sqliteParams();
  const sql = `WITH ${d1Units(p(q.environmentId), p(q.experimentKey), p(q.phase), p(q.startMs), p(q.endMs))}
SELECT CASE WHEN nv > 1 THEN NULL ELSE variation END AS variation, COUNT(*) AS users FROM units GROUP BY 1`;
  return { sql, params };
};

export const d1MomentsSql = (
  q: MomentsOptions & D1Scope & { readonly numerator: EventSource; readonly denominator: EventSource | null },
): D1Query => {
  const { ratio, pre, delayMs, windowMs, capping } = plan(q);
  const { params, p } = sqliteParams();
  const env = p(q.environmentId);
  const end = p(q.endMs);
  const post = `e.ts >= u.t0 + ${p(delayMs)}${windowMs === null ? "" : ` AND e.ts < u.t0 + ${p(windowMs)}`} AND e.ts <= ${end}`;
  const before = `e.ts >= u.t0 - ${p(LOOKBACK_MS)} AND e.ts < u.t0`;
  const value = (source: EventSource, range: string) => {
    const from = `FROM events e WHERE e.environment_id = ${env} AND e.name = ${p(source.event)} AND e.user_id = u.user_id AND ${range}`;
    if (q.metric.type === "proportion") return `EXISTS (SELECT 1 ${from})`;
    return source.aggregation === "count" ? `(SELECT COUNT(*) ${from})` : `(SELECT TOTAL(e.value) ${from})`;
  };
  const y = value(q.numerator, post);
  const d = ratio && q.denominator !== null ? value(q.denominator, post) : "0";
  const x = pre ? value(q.numerator, before) : "0";
  const cap = capping.type === "absolute" ? p(capping.value) : capping.type === "percentile" ? "(SELECT c FROM cap)" : null;
  const percentileCte =
    capping.type === "percentile"
      ? `,
  cap AS (SELECT y AS c FROM vals ORDER BY y LIMIT 1 OFFSET (SELECT CAST(${p(capping.value)} * (COUNT(*) - 1) AS INTEGER) FROM vals))`
      : "";
  // ponytail: one full re-scan per metric per refresh, bounded by D1's 30 s query limit. Measured on
  // local workerd: 1M exposed units + 4M events = 3.6 s and ~10M rows read (linear). Upgrade path:
  // incremental daily moments tables, or BigQuery
  const sql = `WITH ${d1Units(env, p(q.experimentKey), p(q.phase), p(q.startMs), end)},
  vals AS MATERIALIZED (SELECT u.variation, u.t0, ${y} AS y, ${d} AS d, ${x} AS x FROM units u WHERE u.nv = 1)${percentileCte},
  capped AS (
    SELECT variation, t0, ${cap === null ? "y" : `MIN(y, ${cap})`} AS y, d, ${cap === null ? "x" : `MIN(x, ${cap})`} AS x, ${cap ?? "NULL"} AS cap
    FROM vals
  )
SELECT variation, date(t0 / 1000, 'unixepoch') AS day, COUNT(*) AS n,
  TOTAL(y) AS sum_y, TOTAL(y * y) AS sum_y2, TOTAL(d) AS sum_d, TOTAL(d * d) AS sum_d2, TOTAL(y * d) AS sum_yd,
  TOTAL(x) AS sum_x, TOTAL(x * x) AS sum_x2, TOTAL(x * y) AS sum_xy, MAX(cap) AS cap_value
FROM capped GROUP BY variation, day`;
  return { sql, params };
};

// ---------------------------------------------------------------------------------------------
// BigQuery (GoogleSQL). The data source's exposure SQL and the metric SQL are wrapped as CTEs.
// They may reference @experiment_key, @start_ms and @end_ms (epoch ms) for partition pruning

export interface BigQueryQuery {
  readonly sql: string;
  readonly params: Readonly<Record<string, string | number>>;
}

const strip = (sql: string) => sql.trim().replace(/;+$/, "");

const bigQueryUnits = (exposureSql: string) => `kuji_exposure_source AS (
${strip(exposureSql)}
),
kuji_units AS (
  SELECT CAST(user_id AS STRING) AS user_id, MIN(CAST(variation_key AS STRING)) AS variation,
    COUNT(DISTINCT CAST(variation_key AS STRING)) AS nv, MIN(timestamp) AS t0
  FROM kuji_exposure_source
  WHERE experiment_key = @experiment_key AND timestamp >= TIMESTAMP_MILLIS(@start_ms) AND timestamp <= TIMESTAMP_MILLIS(@end_ms)
  GROUP BY 1
)`;

const windowParams = (q: AnalysisWindow) => ({ experiment_key: q.experimentKey, start_ms: q.startMs, end_ms: q.endMs });

export const bigQueryExposureCountsSql = (q: AnalysisWindow & { readonly exposureSql: string }): BigQueryQuery => ({
  sql: `WITH ${bigQueryUnits(q.exposureSql)}
SELECT IF(nv > 1, NULL, variation) AS variation, COUNT(*) AS users FROM kuji_units GROUP BY 1`,
  params: windowParams(q),
});

export const bigQueryMomentsSql = (
  q: MomentsOptions & { readonly exposureSql: string; readonly numeratorSql: string; readonly denominatorSql: string | null },
): BigQueryQuery => {
  const { ratio, pre, delayMs, windowMs, capping } = plan(q);
  const params: Record<string, string | number> = { ...windowParams(q), delay_ms: delayMs };
  const perUnit = (name: string, source: string, range: string) => `${name} AS (
  SELECT u.user_id, SUM(s.value) AS v
  FROM kuji_units u JOIN ${source} s ON CAST(s.user_id AS STRING) = u.user_id
  WHERE u.nv = 1 AND ${range}
  GROUP BY 1
)`;
  let post = "s.timestamp >= TIMESTAMP_MILLIS(UNIX_MILLIS(u.t0) + @delay_ms)";
  if (windowMs !== null) {
    params.window_ms = windowMs;
    post += " AND s.timestamp < TIMESTAMP_MILLIS(UNIX_MILLIS(u.t0) + @window_ms)";
  }
  post += " AND s.timestamp <= TIMESTAMP_MILLIS(@end_ms)";
  // proportion: 1 when the unit has any matching row
  const valueOf = (alias: string) => (q.metric.type === "proportion" ? `IF(${alias}.user_id IS NULL, 0, 1)` : `COALESCE(${alias}.v, 0)`);

  const ctes = [
    bigQueryUnits(q.exposureSql),
    `kuji_numerator_source AS (\n${strip(q.numeratorSql)}\n)`,
    perUnit("kuji_numerator", "kuji_numerator_source", post),
  ];
  const joins = ["LEFT JOIN kuji_numerator m ON m.user_id = u.user_id"];
  const denominator = ratio && q.denominatorSql !== null;
  if (denominator) {
    ctes.push(`kuji_denominator_source AS (\n${strip(q.denominatorSql ?? "")}\n)`, perUnit("kuji_denominator", "kuji_denominator_source", post));
    joins.push("LEFT JOIN kuji_denominator dn ON dn.user_id = u.user_id");
  }
  if (pre) {
    params.lookback_ms = LOOKBACK_MS;
    ctes.push(
      perUnit("kuji_pre", "kuji_numerator_source", "s.timestamp >= TIMESTAMP_MILLIS(UNIX_MILLIS(u.t0) - @lookback_ms) AND s.timestamp < u.t0"),
    );
    joins.push("LEFT JOIN kuji_pre pr ON pr.user_id = u.user_id");
  }
  ctes.push(`kuji_values AS (
  SELECT u.variation, u.t0, ${valueOf("m")} AS y, ${denominator ? "COALESCE(dn.v, 0)" : "0"} AS d, ${pre ? valueOf("pr") : "0"} AS x
  FROM kuji_units u
  ${joins.join("\n  ")}
  WHERE u.nv = 1
)`);

  let cap: string | null = null;
  if (capping.type === "absolute") {
    params.cap_value = capping.value;
    cap = "@cap_value";
  } else if (capping.type === "percentile") {
    params.cap_percentile = capping.value;
    ctes.push(
      "kuji_cap AS (SELECT APPROX_QUANTILES(y, 1000)[OFFSET(CAST(ROUND(@cap_percentile * 1000) AS INT64))] AS c FROM kuji_values)",
    );
    cap = "(SELECT c FROM kuji_cap)";
  }
  ctes.push(`kuji_capped AS (
  SELECT variation, t0, ${cap === null ? "y" : `LEAST(y, ${cap})`} AS y, d, ${cap === null ? "x" : `LEAST(x, ${cap})`} AS x, ${cap ?? "CAST(NULL AS FLOAT64)"} AS cap
  FROM kuji_values
)`);

  const sql = `WITH ${ctes.join(",\n")}
SELECT variation, FORMAT_DATE('%F', DATE(t0)) AS day, COUNT(*) AS n,
  SUM(y) AS sum_y, SUM(y * y) AS sum_y2, SUM(d) AS sum_d, SUM(d * d) AS sum_d2, SUM(y * d) AS sum_yd,
  SUM(x) AS sum_x, SUM(x * x) AS sum_x2, SUM(x * y) AS sum_xy, ANY_VALUE(cap) AS cap_value
FROM kuji_capped GROUP BY variation, day`;
  return { sql, params };
};
