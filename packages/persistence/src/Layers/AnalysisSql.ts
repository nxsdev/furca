/**
 * Experiment analysis SQL for the built-in store (D1 / SQLite) and the warehouses (BigQuery, Snowflake,
 * ClickHouse, Postgres). Every dialect implements the same semantics and returns the same columns, so
 * the stats pipeline does not care which ran:
 *
 * - Units: exposures of the experiment key within [start, end]. Per unit: first exposure t0 and
 *   variation. A unit seen in 2+ variations is a multiple exposure: counted, then excluded.
 *   D1 also filters on the phase index (exposures are stored first-seen per phase, so a unit
 *   re-randomized by a new phase counts again). Warehouse exposure SQL returns view events, so the
 *   phase's time window is what separates phases there
 * - Per-unit value y from the metric's events with t0 + delay <= ts < t0 + window (no upper bound
 *   without a window) and ts <= end. proportion: 1 if any event; mean: count / sum; ratio: numerator y
 *   and denominator d. Units without events are 0
 * - CUPED covariate x: the same value over [t0 - 14 days, t0) (not for ratio metrics)
 * - Capping on per-unit y and x, never on raw events: absolute min(v, cap), or the p-quantile of y
 *   pooled across variations (D1: nearest rank floor(p·(n−1)); BigQuery: APPROX_QUANTILES, 0.1% grid;
 *   Snowflake / Postgres: PERCENTILE_DISC; ClickHouse: quantileExact).
 *   Not applied to proportion metrics (values are 0/1). Ratio metrics cap the numerator only
 *
 * - Metric property filters (built-in store only; warehouse SQL writes its own WHERE) are AND-ed on
 *   events: eq / neq / in / not_in / contains compare the value as text (booleans as "true" / "false"),
 *   gt / gte / lt / lte compare JSON numbers. A missing property only matches neq, not_in, not_exists
 * - Breakdowns (`dimension`): each unit gets a `slice`, its first exposure's value of that dimension.
 *   The 20 values with the most units keep their name, the rest become "(other)", missing "(not set)".
 *   Every output gains a leading `slice` column; capping stays pooled across slices
 *
 * Exposure counts columns: variation (NULL = multiple exposure), users
 * Moments columns: variation, day (UTC date of t0, YYYY-MM-DD), n, sum_y, sum_y2, sum_d, sum_d2,
 * sum_yd, sum_x, sum_x2, sum_xy, cap_value
 *
 * User input is always a bound parameter. The only interpolated text is warehouse SQL written by
 * admins (data source exposure SQL, metric SQL), which is the point of a warehouse-native source, and
 * the cap percentile (a range-checked number) where the warehouse needs a literal
 */
import type { WarehouseType } from "@furca/core/datasources/DataSource";
import type { EventSource, Metric, PropertyFilter } from "@furca/core/metrics/Metric";

const HOUR_MS = 3_600_000;
export const LOOKBACK_MS = 14 * 24 * HOUR_MS;
export const TOP_SLICES = 20;
export const OTHER_SLICE = "(other)";
export const NOT_SET_SLICE = "(not set)";

export interface AnalysisWindow {
  readonly experimentKey: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Break results down by this exposure dimension (adds a leading `slice` column) */
  readonly dimension?: string | null;
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

/** `$."name"` for json_extract. Names containing " or \ cannot be addressed (validated on save) */
const jsonPath = (name: string) => `$."${name}"`;

/** Same top-20 / "(other)" / "(not set)" bucketing in both dialects; `dim` is the unit's raw value */
const sliceOf = (units: string) => `CASE WHEN dim IS NULL THEN '${NOT_SET_SLICE}'
      WHEN dim IN (SELECT dim FROM ${units} WHERE nv = 1 AND dim IS NOT NULL GROUP BY dim ORDER BY COUNT(*) DESC, dim LIMIT ${TOP_SLICES})
      THEN dim ELSE '${OTHER_SLICE}' END`;

/** Uses the primary key (environment_id, experiment_key, phase, user_id, variation_key) */
const d1Units = (env: string, key: string, phase: string, start: string, end: string, dimPath: string | null) => {
  const units = `SELECT user_id, MIN(variation_key) AS variation, COUNT(*) AS nv, MIN(first_seen_at) AS t0${
    dimPath === null ? "" : `, CAST(MIN(json_extract(dimensions, ${dimPath})) AS TEXT) AS dim`
  }
    FROM exposures
    WHERE environment_id = ${env} AND experiment_key = ${key} AND phase = ${phase}
      AND first_seen_at >= ${start} AND first_seen_at <= ${end}
    GROUP BY user_id`;
  if (dimPath === null) return `units AS (\n    ${units}\n  )`;
  return `exposed AS MATERIALIZED (\n    ${units}\n  ),
  units AS (SELECT *, ${sliceOf("exposed")} AS slice FROM exposed)`;
};

export const d1ExposureCountsSql = (q: AnalysisWindow & D1Scope): D1Query => {
  const { params, p } = sqliteParams();
  const dim = q.dimension == null ? null : p(jsonPath(q.dimension));
  const sql = `WITH ${d1Units(p(q.environmentId), p(q.experimentKey), p(q.phase), p(q.startMs), p(q.endMs), dim)}
SELECT ${dim === null ? "" : "slice, "}CASE WHEN nv > 1 THEN NULL ELSE variation END AS variation, COUNT(*) AS users
FROM units GROUP BY ${dim === null ? "1" : "1, 2"}`;
  return { sql, params };
};

/**
 * One property filter on events `e` as a SQL predicate. Two bound parameters at most (the JSON path
 * and the value, or the values as one JSON array), so D1's 100-parameter limit holds
 */
const d1Filter = (f: PropertyFilter, p: (v: string | number) => string) => {
  const path = p(jsonPath(f.property));
  const raw = `json_extract(e.properties, ${path})`;
  const type = `json_type(e.properties, ${path})`;
  const text = `(CASE ${type} WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(${raw} AS TEXT) END)`;
  const value = () => p(f.values[0] ?? "");
  const number = (op: string) => `(${type} IN ('integer', 'real') AND ${raw} ${op} ${p(Number(f.values[0]))})`;
  const anyOf = () => `${text} IN (SELECT value FROM json_each(${p(JSON.stringify(f.values))}))`;
  switch (f.operator) {
    case "eq":
      return `${text} = ${value()}`;
    case "neq":
      return `${text} IS NOT ${value()}`;
    case "in":
      return anyOf();
    case "not_in":
      return `NOT COALESCE(${anyOf()}, 0)`;
    case "contains":
      return `instr(${text}, ${value()}) > 0`;
    case "gt":
      return number(">");
    case "gte":
      return number(">=");
    case "lt":
      return number("<");
    case "lte":
      return number("<=");
    case "exists":
      return `${raw} IS NOT NULL`;
    case "not_exists":
      return `${raw} IS NULL`;
  }
};

/**
 * Pre-experiment baseline of one event source (power planner prefill). Units: users with any event or
 * exposure in the environment since `sinceMs`; y = their count / sum of matching events (0 without
 * one). Columns: n, converted (units with a matching event), sum_y, sum_y2, first_ts
 */
export const d1BaselineSql = (q: { readonly environmentId: string; readonly sinceMs: number; readonly source: EventSource }): D1Query => {
  const { params, p } = sqliteParams();
  const env = p(q.environmentId);
  const since = p(q.sinceMs);
  const filters = q.source.filters.map((f) => ` AND ${d1Filter(f, p)}`).join("");
  const y = q.source.aggregation === "count" ? "COALESCE(m.c, 0)" : "COALESCE(m.s, 0)";
  // ponytail: no capping, so a heavy-tailed sum gives a wide stdDev (a longer, safer plan); cap here if plans look too long
  const sql = `WITH units AS (
    SELECT user_id FROM events WHERE environment_id = ${env} AND ts >= ${since}
    UNION SELECT user_id FROM exposures WHERE environment_id = ${env} AND first_seen_at >= ${since}
  ),
  m AS (
    SELECT e.user_id, COUNT(*) AS c, TOTAL(e.value) AS s FROM events e
    WHERE e.environment_id = ${env} AND e.name = ${p(q.source.event)} AND e.ts >= ${since}${filters}
    GROUP BY e.user_id
  )
SELECT COUNT(*) AS n, COUNT(m.user_id) AS converted, TOTAL(${y}) AS sum_y, TOTAL(${y} * ${y}) AS sum_y2,
  (SELECT MIN(ts) FROM events WHERE environment_id = ${env} AND ts >= ${since}) AS first_ts
FROM units u LEFT JOIN m ON m.user_id = u.user_id`;
  return { sql, params };
};

export const d1MomentsSql = (
  q: MomentsOptions & D1Scope & { readonly numerator: EventSource; readonly denominator: EventSource | null },
): D1Query => {
  const { ratio, pre, delayMs, windowMs, capping } = plan(q);
  const { params, p } = sqliteParams();
  const env = p(q.environmentId);
  const end = p(q.endMs);
  const dim = q.dimension == null ? null : p(jsonPath(q.dimension));
  const slice = dim === null ? "" : "slice, ";
  const post = `e.ts >= u.t0 + ${p(delayMs)}${windowMs === null ? "" : ` AND e.ts < u.t0 + ${p(windowMs)}`} AND e.ts <= ${end}`;
  const before = `e.ts >= u.t0 - ${p(LOOKBACK_MS)} AND e.ts < u.t0`;
  /** Event name + filters, bound once per source and shared by the post and pre-period subqueries */
  const match = (source: EventSource) =>
    [`e.name = ${p(source.event)}`, ...source.filters.map((f) => d1Filter(f, p))].join(" AND ");
  const value = (where: string, aggregation: EventSource["aggregation"], range: string) => {
    const from = `FROM events e WHERE e.environment_id = ${env} AND ${where} AND e.user_id = u.user_id AND ${range}`;
    if (q.metric.type === "proportion") return `EXISTS (SELECT 1 ${from})`;
    return aggregation === "count" ? `(SELECT COUNT(*) ${from})` : `(SELECT TOTAL(e.value) ${from})`;
  };
  const numerator = match(q.numerator);
  const y = value(numerator, q.numerator.aggregation, post);
  const d = ratio && q.denominator !== null ? value(match(q.denominator), q.denominator.aggregation, post) : "0";
  const x = pre ? value(numerator, q.numerator.aggregation, before) : "0";
  const cap = capping.type === "absolute" ? p(capping.value) : capping.type === "percentile" ? "(SELECT c FROM cap)" : null;
  const percentileCte =
    capping.type === "percentile"
      ? `,
  cap AS (SELECT y AS c FROM vals ORDER BY y LIMIT 1 OFFSET (SELECT CAST(${p(capping.value)} * (COUNT(*) - 1) AS INTEGER) FROM vals))`
      : "";
  // ponytail: one full re-scan per metric per refresh, bounded by D1's 30 s query limit. Measured on
  // local workerd: 1M exposed units + 4M events = 3.6 s and ~10M rows read (linear). Upgrade path:
  // incremental daily moments tables, or BigQuery
  const sql = `WITH ${d1Units(env, p(q.experimentKey), p(q.phase), p(q.startMs), end, dim)},
  vals AS MATERIALIZED (SELECT ${slice}u.variation, u.t0, ${y} AS y, ${d} AS d, ${x} AS x FROM units u WHERE u.nv = 1)${percentileCte},
  capped AS (
    SELECT ${slice}variation, t0, ${cap === null ? "y" : `MIN(y, ${cap})`} AS y, d, ${cap === null ? "x" : `MIN(x, ${cap})`} AS x, ${cap ?? "NULL"} AS cap
    FROM vals
  )
SELECT ${slice}variation, date(t0 / 1000, 'unixepoch') AS day, COUNT(*) AS n,
  TOTAL(y) AS sum_y, TOTAL(y * y) AS sum_y2, TOTAL(d) AS sum_d, TOTAL(d * d) AS sum_d2, TOTAL(y * d) AS sum_yd,
  TOTAL(x) AS sum_x, TOTAL(x * x) AS sum_x2, TOTAL(x * y) AS sum_xy, MAX(cap) AS cap_value
FROM capped GROUP BY ${slice}variation, day`;
  return { sql, params };
};

// ---------------------------------------------------------------------------------------------
// Warehouses (BigQuery, Snowflake, ClickHouse, Postgres): one builder, a small dialect per engine.
// The data source's exposure SQL and the metric SQL are wrapped as CTEs. Parameters are written
// `@name` and bound natively by each client; admin SQL may use @experiment_id, @start_ms and
// @end_ms (epoch ms) too, e.g. for BigQuery wildcard-table pruning. Internal aliases never shadow a
// column of the same name and NULL-extended join columns are read through COALESCE, so ClickHouse
// needs no session settings (works for readonly users)

export interface WarehouseQuery {
  readonly sql: string;
  readonly params: Readonly<Record<string, string | number>>;
}

interface Dialect {
  /** A validated plain identifier, quoted to match how the warehouse stores unquoted names */
  readonly column: (name: string) => string;
  readonly text: (expr: string) => string;
  /** The first non-null `expr` ordered by `timestamp`, as an aggregate */
  readonly first: (expr: string) => string;
  /** Timestamp from an epoch-milliseconds expression */
  readonly fromMs: (ms: string) => string;
  /** `ts` shifted by `ms` milliseconds */
  readonly shift: (ts: string, sign: "+" | "-", ms: string) => string;
  /** UTC calendar date of `ts` as YYYY-MM-DD */
  readonly day: (ts: string) => string;
  /** p-quantile of y0 over furca_values. BigQuery binds @cap_percentile; the others need a literal */
  readonly quantile: (p: string) => string;
  /** Per-unit values as floats where integer and float types do not mix (ClickHouse least()) */
  readonly float: (expr: string) => string;
  readonly nullFloat: string;
}

export const DIALECTS: Record<WarehouseType, Dialect> = {
  bigquery: {
    column: (name) => `\`${name}\``,
    text: (e) => `CAST(${e} AS STRING)`,
    first: (e) => `ARRAY_AGG(${e} IGNORE NULLS ORDER BY timestamp LIMIT 1)[SAFE_OFFSET(0)]`,
    fromMs: (ms) => `TIMESTAMP_MILLIS(${ms})`,
    shift: (ts, sign, ms) => `TIMESTAMP_MILLIS(UNIX_MILLIS(${ts}) ${sign} ${ms})`,
    day: (ts) => `FORMAT_DATE('%F', DATE(${ts}))`,
    // 0.1% grid
    quantile: () => "APPROX_QUANTILES(y0, 1000)[OFFSET(CAST(ROUND(@cap_percentile * 1000) AS INT64))]",
    float: (e) => e,
    nullFloat: "CAST(NULL AS FLOAT64)",
  },
  snowflake: {
    // Unquoted identifiers are stored upper-case
    column: (name) => `"${name.toUpperCase()}"`,
    text: (e) => `CAST(${e} AS VARCHAR)`,
    // ARRAY_AGG drops NULLs
    first: (e) => `GET(ARRAY_AGG(${e}) WITHIN GROUP (ORDER BY timestamp), 0)::VARCHAR`,
    // The client runs the session in UTC, so TIMESTAMP_NTZ columns read as UTC
    fromMs: (ms) => `TO_TIMESTAMP_LTZ(${ms}, 3)`,
    shift: (ts, sign, ms) => `DATEADD(millisecond, ${sign === "-" ? "-" : ""}${ms}, ${ts})`,
    day: (ts) => `TO_CHAR(CONVERT_TIMEZONE('UTC', ${ts}), 'YYYY-MM-DD')`,
    quantile: (p) => `PERCENTILE_DISC(${p}) WITHIN GROUP (ORDER BY y0)`,
    float: (e) => e,
    nullFloat: "CAST(NULL AS DOUBLE)",
  },
  clickhouse: {
    // Identifiers are case-sensitive
    column: (name) => `\`${name}\``,
    text: (e) => `toString(${e})`,
    first: (e) => `argMinIf(${e}, timestamp, ${e} IS NOT NULL)`,
    fromMs: (ms) => `fromUnixTimestamp64Milli(${ms})`,
    shift: (ts, sign, ms) => `${sign === "+" ? "addMilliseconds" : "subtractMilliseconds"}(${ts}, ${ms})`,
    day: (ts) => `toString(toDate(${ts}, 'UTC'))`,
    quantile: (p) => `quantileExact(${p})(y0)`,
    float: (e) => `toFloat64(${e})`,
    nullFloat: "CAST(NULL AS Nullable(Float64))",
  },
  postgres: {
    // Unquoted identifiers are stored lower-case
    column: (name) => `"${name.toLowerCase()}"`,
    text: (e) => `CAST(${e} AS TEXT)`,
    first: (e) => `(ARRAY_AGG(${e} ORDER BY timestamp) FILTER (WHERE ${e} IS NOT NULL))[1]`,
    // The client runs the session in UTC, so timestamp without time zone reads as UTC
    fromMs: (ms) => `to_timestamp(${ms} / 1000.0)`,
    shift: (ts, sign, ms) => `(${ts} ${sign} ${ms} * INTERVAL '1 millisecond')`,
    day: (ts) => `to_char(${ts}, 'YYYY-MM-DD')`,
    quantile: (p) => `PERCENTILE_DISC(${p}) WITHIN GROUP (ORDER BY y0)`,
    float: (e) => e,
    nullFloat: "CAST(NULL AS DOUBLE PRECISION)",
  },
};

const strip = (sql: string) => sql.trim().replace(/;+$/, "");

/** Breakdown dimensions are exposure SQL columns, so they must be plain identifiers */
export const isWarehouseColumn = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,299}$/.test(name);

const warehouseUnits = (d: Dialect, exposureSql: string, dimension: string | null | undefined) => {
  if (dimension != null && !isWarehouseColumn(dimension)) throw new Error(`Invalid column name: ${dimension}`);
  const units = `SELECT ${d.text("user_id")} AS unit_id, MIN(${d.text("variation_id")}) AS arm,
    COUNT(DISTINCT ${d.text("variation_id")}) AS nv, MIN(timestamp) AS t0${
      dimension == null ? "" : `,\n    ${d.first(d.text(d.column(dimension)))} AS dim`
    }
  FROM furca_exposure_source
  WHERE experiment_id = @experiment_id AND timestamp >= ${d.fromMs("@start_ms")} AND timestamp <= ${d.fromMs("@end_ms")}
  GROUP BY 1`;
  return `furca_exposure_source AS (
${strip(exposureSql)}
),
${
  dimension == null
    ? `furca_units AS (\n  ${units}\n)`
    : `furca_exposed AS (\n  ${units}\n),\nfurca_units AS (SELECT *, ${sliceOf("furca_exposed")} AS slice FROM furca_exposed)`
}`;
};

const windowParams = (q: AnalysisWindow) => ({ experiment_id: q.experimentKey, start_ms: q.startMs, end_ms: q.endMs });

export const warehouseExposureCountsSql = (type: WarehouseType, q: AnalysisWindow & { readonly exposureSql: string }): WarehouseQuery => ({
  sql: `WITH ${warehouseUnits(DIALECTS[type], q.exposureSql, q.dimension)}
SELECT ${q.dimension == null ? "" : "slice, "}CASE WHEN nv > 1 THEN NULL ELSE arm END AS variation, COUNT(*) AS users
FROM furca_units GROUP BY ${q.dimension == null ? "1" : "1, 2"}`,
  params: windowParams(q),
});

export const warehouseMomentsSql = (
  type: WarehouseType,
  q: MomentsOptions & { readonly exposureSql: string; readonly numeratorSql: string; readonly denominatorSql: string | null },
): WarehouseQuery => {
  const d = DIALECTS[type];
  const { ratio, pre, delayMs, windowMs, capping } = plan(q);
  const slice = q.dimension == null ? "" : "slice, ";
  const params: Record<string, string | number> = { ...windowParams(q), delay_ms: delayMs };
  // Events on the left: ClickHouse builds the join's hash table from the right side (the units)
  const perUnit = (name: string, source: string, range: string) => `${name} AS (
  SELECT u.unit_id, SUM(s.value) AS v, COUNT(*) AS c
  FROM ${source} s JOIN furca_units u ON ${d.text("s.user_id")} = u.unit_id
  WHERE u.nv = 1 AND ${range}
  GROUP BY 1
)`;
  let post = `s.timestamp >= ${d.shift("u.t0", "+", "@delay_ms")}`;
  if (windowMs !== null) {
    params.window_ms = windowMs;
    post += ` AND s.timestamp < ${d.shift("u.t0", "+", "@window_ms")}`;
  }
  post += ` AND s.timestamp <= ${d.fromMs("@end_ms")}`;
  // proportion: 1 when the unit has any matching row
  const valueOf = (alias: string) =>
    q.metric.type === "proportion" ? `CASE WHEN COALESCE(${alias}.c, 0) > 0 THEN 1 ELSE 0 END` : `COALESCE(${alias}.v, 0)`;

  const ctes = [
    warehouseUnits(d, q.exposureSql, q.dimension),
    `furca_numerator_source AS (\n${strip(q.numeratorSql)}\n)`,
    perUnit("furca_numerator", "furca_numerator_source", post),
  ];
  const joins = ["LEFT JOIN furca_numerator m ON m.unit_id = u.unit_id"];
  const denominator = ratio && q.denominatorSql !== null;
  if (denominator) {
    ctes.push(`furca_denominator_source AS (\n${strip(q.denominatorSql ?? "")}\n)`, perUnit("furca_denominator", "furca_denominator_source", post));
    joins.push("LEFT JOIN furca_denominator dn ON dn.unit_id = u.unit_id");
  }
  if (pre) {
    params.lookback_ms = LOOKBACK_MS;
    ctes.push(perUnit("furca_pre", "furca_numerator_source", `s.timestamp >= ${d.shift("u.t0", "-", "@lookback_ms")} AND s.timestamp < u.t0`));
    joins.push("LEFT JOIN furca_pre pr ON pr.unit_id = u.unit_id");
  }
  ctes.push(`furca_values AS (
  SELECT ${slice}u.arm AS variation, u.t0, ${d.float(valueOf("m"))} AS y0, ${d.float(denominator ? "COALESCE(dn.v, 0)" : "0")} AS d, ${d.float(pre ? valueOf("pr") : "0")} AS x0
  FROM furca_units u
  ${joins.join("\n  ")}
  WHERE u.nv = 1
)`);

  let cap: string | null = null;
  if (capping.type === "absolute") {
    params.cap_value = capping.value;
    cap = d.float("@cap_value");
  } else if (capping.type === "percentile") {
    if (!(capping.value >= 0 && capping.value <= 1)) throw new Error(`Invalid cap percentile: ${capping.value}`);
    params.cap_percentile = capping.value;
    ctes.push(`furca_cap AS (SELECT ${d.quantile(String(capping.value))} AS c FROM furca_values)`);
    cap = "(SELECT c FROM furca_cap)";
  }
  ctes.push(`furca_capped AS (
  SELECT ${slice}variation, t0, ${cap === null ? "y0" : `least(y0, ${cap})`} AS y, d, ${cap === null ? "x0" : `least(x0, ${cap})`} AS x, ${cap ?? d.nullFloat} AS cap
  FROM furca_values
)`);

  const sql = `WITH ${ctes.join(",\n")}
SELECT ${slice}variation, ${d.day("t0")} AS day, COUNT(*) AS n,
  SUM(y) AS sum_y, SUM(y * y) AS sum_y2, SUM(d) AS sum_d, SUM(d * d) AS sum_d2, SUM(y * d) AS sum_yd,
  SUM(x) AS sum_x, SUM(x * x) AS sum_x2, SUM(x * y) AS sum_xy, MAX(cap) AS cap_value
FROM furca_capped GROUP BY ${slice}variation, day`;
  return { sql, params };
};
