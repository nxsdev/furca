import { ExperimentAnalysisService } from "@furca/core/analysis/Analysis";
import { CredentialCipher } from "@furca/core/datasources/CredentialCipher";
import type { Experiment, ExperimentPhase } from "@furca/core/experiments/Experiment";
import type { Metric } from "@furca/core/metrics/Metric";
import {
  ExperimentHealth,
  MetricResult,
  type MetricRole,
  ResultSnapshot,
  SrmCheck,
  TimeseriesPoint,
  VariationComparison,
  VariationMetricSummary,
} from "@furca/core/results/ExperimentResult";
import { NotFoundError, ValidationError, WarehouseError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { dataSources as dataSourcesTable, resultSnapshots } from "@furca/database/schema/index";
import * as BigQuery from "@furca/integrations/bigquery/client";
import {
  adjustedInterval,
  type AnalysisSettings,
  type ComparisonOutcome,
  compareVariations,
  cumulative,
  holmAdjust,
  type MetricKind,
  type Moments,
  SRM_THRESHOLD,
  srmPValue,
  summarize,
  verdict,
} from "@furca/stats";
import { Effect, Layer, Schema } from "effect";
import { toDataSource, toExperiment, toMetric } from "../mappers";
import {
  type AnalysisWindow,
  bigQueryExposureCountsSql,
  bigQueryMomentsSql,
  type BigQueryQuery,
  d1ExposureCountsSql,
  d1MomentsSql,
  type D1Query,
} from "./AnalysisSql";

type Rows = ReadonlyArray<Record<string, unknown>>;

/** Runs the exposure-count and moments queries of one experiment against its data source */
interface AnalysisSource {
  readonly exposureCounts: Effect.Effect<Rows, WarehouseError>;
  readonly moments: (metric: Metric, cuped: boolean) => Effect.Effect<Rows, WarehouseError>;
}

const builtinSource = (d1: D1Database, environmentId: string, phase: number, window: AnalysisWindow): AnalysisSource => {
  const all = (q: D1Query) =>
    Effect.tryPromise({
      try: () =>
        d1
          .prepare(q.sql)
          .bind(...q.params)
          .all<Record<string, unknown>>()
          .then((r) => r.results),
      catch: (cause) =>
        new WarehouseError({
          message: `Built-in event store query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(Effect.withSpan("analysis.d1"));
  return {
    exposureCounts: all(d1ExposureCountsSql({ ...window, environmentId, phase })),
    moments: (metric, cuped) =>
      metric.definition._tag === "event"
        ? all(
            d1MomentsSql({
              ...window,
              environmentId,
              phase,
              metric,
              cuped,
              numerator: metric.definition.numerator,
              denominator: metric.definition.denominator,
            }),
          )
        : Effect.fail(new WarehouseError({ message: `Metric "${metric.name}" is SQL-based; the built-in event store cannot run it` })),
  };
};

const bigQuerySource = (
  sa: BigQuery.ServiceAccount,
  target: BigQuery.BigQueryTarget,
  exposureSql: string,
  window: AnalysisWindow,
): AnalysisSource => {
  const run = (q: BigQueryQuery) => BigQuery.query(sa, target, q.sql, q.params);
  return {
    exposureCounts: run(bigQueryExposureCountsSql({ ...window, exposureSql })),
    moments: (metric, cuped) =>
      metric.definition._tag === "sql"
        ? run(
            bigQueryMomentsSql({
              ...window,
              exposureSql,
              metric,
              cuped,
              numeratorSql: metric.definition.numeratorSql,
              denominatorSql: metric.definition.denominatorSql,
            }),
          )
        : Effect.fail(new WarehouseError({ message: `Metric "${metric.name}" uses built-in events; BigQuery cannot read them` })),
  };
};

const momentsOf = (row: Record<string, unknown>, kind: MetricKind, pre: boolean): Moments => {
  const v = (column: string) => Number(row[column] ?? 0);
  return {
    n: v("n"),
    sum: v("sum_y"),
    sumSquares: v("sum_y2"),
    ...(kind === "ratio" ? { denominatorSum: v("sum_d"), denominatorSumSquares: v("sum_d2"), crossSum: v("sum_yd") } : {}),
    ...(pre ? { preSum: v("sum_x"), preSumSquares: v("sum_x2"), prePostSum: v("sum_xy") } : {}),
  };
};

const healthOf = (experiment: Experiment, phase: ExperimentPhase, rows: Rows): ExperimentHealth => {
  const users = new Map(rows.map((r) => [r.variation == null ? null : String(r.variation), Number(r.users)]));
  const observed = experiment.variations.map((v) => users.get(v.key) ?? 0);
  const multiple = users.get(null) ?? 0;
  const totalUsers = observed.reduce((a, b) => a + b, 0);
  const pValue = srmPValue(observed, phase.weights);
  return ExperimentHealth.make({
    totalUsers,
    srm: SrmCheck.make({ pValue, observed, expectedWeights: phase.weights, ok: pValue === null || pValue >= SRM_THRESHOLD }),
    multipleExposureUsers: multiple,
    multipleExposuresOk: multiple === 0 || multiple / (totalUsers + multiple) < 0.01,
  });
};

type Measured = { readonly id: string; readonly role: MetricRole } & (
  | { readonly metric: Metric; readonly rows: Rows }
  | { readonly error: string }
);

const finite = (...values: ReadonlyArray<number | null>) => values.every((v) => v === null || Number.isFinite(v));

const inconclusive = (variationKey: string, message: string) =>
  VariationComparison.make({
    variationKey,
    lift: null,
    ci: null,
    absoluteDiff: null,
    pValue: null,
    chanceToWin: null,
    verdict: "inconclusive",
    message,
  });

/**
 * Moments rows -> per-variation summaries, comparisons vs control (index 0) and the cumulative
 * timeseries. Holm-corrects frequentist p-values per family (primary, secondary)
 */
export const analyzeMetrics = (measured: ReadonlyArray<Measured>, experiment: Experiment): MetricResult[] => {
  const { stats } = experiment;
  const keys = experiment.variations.map((v) => v.key);
  const settings: AnalysisSettings = {
    engine: stats.engine,
    sequential: stats.sequential,
    sequentialTuning: stats.sequentialTuning,
    alpha: stats.alpha,
    cuped: stats.cuped,
    priorStdDev: null,
  };

  const computed = measured.map((m) => {
    if ("error" in m) return m;
    const kind = m.metric.type;
    const pre = stats.cuped && kind !== "ratio";
    const byDay = new Map<string, Moments[]>();
    for (const row of m.rows) {
      const i = keys.indexOf(String(row.variation));
      if (i < 0) continue; // variation keys the experiment does not define
      const day = String(row.day);
      const moments = byDay.get(day) ?? keys.map(() => momentsOf({}, kind, pre));
      moments[i] = momentsOf(row, kind, pre);
      byDay.set(day, moments);
    }
    const points = cumulative([...byDay].map(([date, moments]) => ({ date, moments })));
    const compare = (moments: ReadonlyArray<Moments>): ComparisonOutcome[] =>
      moments.slice(1).map((treatment) =>
        compareVariations({ kind, inverse: m.metric.inverse, control: moments[0]!, treatment, settings }),
      );
    const totals = points.at(-1)?.moments ?? keys.map(() => momentsOf({}, kind, pre));
    return { ...m, kind, points, totals, outcomes: compare(totals), compare };
  });

  // Holm families: the primary metric (across treatments) and the secondary metrics (metrics x
  // treatments) are corrected separately, so adding exploratory metrics never costs the decision
  // metric power. Guardrails are uncorrected: a missed regression is the costlier error there
  const adjusted = new Map<string, number>();
  if (stats.engine === "frequentist" && stats.correction === "holm") {
    for (const role of ["primary", "secondary"] as const) {
      const tests = computed.flatMap((c, mi) =>
        "error" in c || c.role !== role
          ? []
          : c.outcomes.flatMap((o, i) => (o.ok && o.result.pValue !== null ? [{ key: `${mi}:${i}`, p: o.result.pValue }] : [])),
      );
      // A family of one needs no correction (and must keep its exact interval)
      if (tests.length > 1) holmAdjust(tests.map((t) => t.p)).forEach((p, i) => adjusted.set(tests[i]!.key, p));
    }
  }

  return computed.map((c, mi) => {
    if ("error" in c) {
      return MetricResult.make({
        metricId: c.id,
        role: c.role,
        variations: [],
        comparisons: [],
        timeseries: [],
        capValue: null,
        cupedApplied: false,
        error: c.error,
      });
    }
    const comparisons = c.outcomes.map((outcome, i) => {
      const variationKey = keys[i + 1]!;
      if (!outcome.ok) return inconclusive(variationKey, outcome.reason);
      const raw = outcome.result;
      const adjustedP = adjusted.get(`${mi}:${i}`);
      let result = raw;
      if (adjustedP !== undefined) {
        const [lo, hi] = adjustedInterval(adjustedP, raw.lift, stats.alpha);
        // ponytail: an unbounded adjusted interval (adjusted p ≈ 1) keeps the raw one; JSON has no ±Infinity
        const ci: readonly [number, number] =
          Number.isFinite(lo) && Number.isFinite(hi) ? [Math.min(raw.ci[0], lo), Math.max(raw.ci[1], hi)] : raw.ci;
        result = { ...raw, pValue: adjustedP, ci };
      }
      if (!finite(result.lift, result.absoluteDiff, ...result.ci, result.pValue, result.chanceToWin)) {
        return inconclusive(variationKey, "The estimate is not a finite number");
      }
      return VariationComparison.make({
        variationKey,
        lift: result.lift,
        ci: result.ci,
        absoluteDiff: result.absoluteDiff,
        pValue: result.pValue,
        chanceToWin: result.chanceToWin,
        verdict: verdict({ ok: true, result }, { engine: stats.engine, alpha: stats.alpha, inverse: c.metric.inverse }),
        message: null,
      });
    });
    const timeseries = c.points.map(({ date, moments }) =>
      TimeseriesPoint.make({
        date,
        users: moments.reduce((sum, m) => sum + m.n, 0),
        comparisons: c.compare(moments).map((o, i) => {
          const ok = o.ok && finite(o.result.lift, ...o.result.ci);
          return { variationKey: keys[i + 1]!, lift: ok ? o.result.lift : null, ci: ok ? o.result.ci : null };
        }),
      }),
    );
    const cap = c.rows.find((r) => r.cap_value != null)?.cap_value;
    return MetricResult.make({
      metricId: c.id,
      role: c.role,
      variations: c.totals.map((m, i) => {
        const s = summarize(c.kind, m);
        return VariationMetricSummary.make({ variationKey: keys[i]!, users: s.n, total: s.total, mean: s.mean });
      }),
      comparisons,
      timeseries,
      capValue: cap === undefined ? null : Number(cap),
      cupedApplied: c.outcomes.some((o) => o.ok && o.result.cupedApplied),
      error: null,
    });
  });
};

const encodeHealth = Schema.encodeSync(Schema.NullOr(ExperimentHealth));
const encodeMetrics = Schema.encodeSync(Schema.Array(MetricResult));
const decodeHealth = Schema.decodeUnknownSync(Schema.NullOr(ExperimentHealth));
const decodeMetrics = Schema.decodeUnknownSync(Schema.Array(MetricResult));
const decodeStatus = Schema.decodeUnknownSync(Schema.Literals(["ok", "error"]));

const toResultSnapshot = (row: typeof resultSnapshots.$inferSelect): ResultSnapshot =>
  ResultSnapshot.make({
    id: row.id,
    experimentId: row.experimentId,
    phaseIndex: row.phaseIndex,
    computedAt: row.computedAt,
    status: decodeStatus(row.status),
    error: row.error,
    health: decodeHealth(row.health),
    metrics: decodeMetrics(row.metrics),
  });

export const ExperimentAnalysisServiceLive = Layer.effect(
  ExperimentAnalysisService,
  Effect.gen(function* () {
    const database = yield* Database;
    const cipher = yield* CredentialCipher;

    const loadExperiment = (id: string) =>
      database
        .run("experiments.get", (db) => db.query.experiments.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) =>
            row === undefined ? Effect.fail(new NotFoundError({ entity: "experiment", id })) : Effect.succeed(toExperiment(row)),
          ),
        );

    const sourceFor = Effect.fn("ExperimentAnalysisService.source")(function* (
      experiment: Experiment,
      row: typeof dataSourcesTable.$inferSelect | undefined,
      phaseIndex: number,
      window: AnalysisWindow,
    ) {
      if (row === undefined) {
        return yield* new WarehouseError({ message: `The experiment's data source ${experiment.dataSourceId} no longer exists` });
      }
      const dataSource = toDataSource(row);
      if (dataSource.type === "builtin") return builtinSource(database.d1, experiment.analysisEnvironmentId, phaseIndex, window);
      if (dataSource.bigquery === null || row.credentials === null) {
        return yield* new WarehouseError({ message: `BigQuery data source "${dataSource.name}" has no project or service account key` });
      }
      if (dataSource.exposureSql.trim() === "") {
        return yield* new WarehouseError({ message: `BigQuery data source "${dataSource.name}" has no exposure SQL` });
      }
      const json = yield* cipher
        .decrypt(row.credentials)
        .pipe(Effect.mapError((e) => new WarehouseError({ message: e.message })));
      const sa = yield* BigQuery.parseServiceAccount(json);
      return bigQuerySource(sa, dataSource.bigquery, dataSource.exposureSql, window);
    });

    const analyze = Effect.fn("ExperimentAnalysisService.analyze")(function* (
      experiment: Experiment,
      phaseIndex: number,
      phase: ExperimentPhase,
      now: Date,
    ) {
      const window: AnalysisWindow = {
        experimentKey: experiment.key,
        startMs: phase.startedAt.getTime(),
        endMs: (phase.endedAt ?? now).getTime(),
      };
      const roles: ReadonlyArray<{ readonly id: string; readonly role: MetricRole }> = [
        ...(experiment.primaryMetricId === null ? [] : [{ id: experiment.primaryMetricId, role: "primary" as const }]),
        ...experiment.secondaryMetricIds.map((id) => ({ id, role: "secondary" as const })),
        ...experiment.guardrailMetricIds.map((id) => ({ id, role: "guardrail" as const })),
      ];
      const dataSources = new Map(
        (yield* database.run("dataSources.list", (db) => db.query.dataSources.findMany())).map((r) => [r.id, r]),
      );
      const metrics = new Map(
        (yield* database.run("metrics.byIds", (db) =>
          db.query.metrics.findMany({ where: { id: { in: roles.map((r) => r.id) } } }),
        )).map((r) => [r.id, toMetric(r)]),
      );

      const source = yield* sourceFor(experiment, dataSources.get(experiment.dataSourceId), phaseIndex, window);
      const health = healthOf(experiment, phase, yield* source.exposureCounts);

      const problem = (metric: Metric): string | null => {
        const own = dataSources.get(metric.dataSourceId);
        if (own === undefined) return `Metric "${metric.name}" uses data source ${metric.dataSourceId} which no longer exists`;
        if (metric.dataSourceId !== experiment.dataSourceId) {
          return `Metric "${metric.name}" uses data source "${own.name}", not the experiment's data source`;
        }
        const d = metric.definition;
        if (metric.type === "ratio" && (d._tag === "event" ? d.denominator === null : d.denominatorSql === null)) {
          return `Ratio metric "${metric.name}" has no denominator`;
        }
        return null;
      };

      const measured = yield* Effect.forEach(
        roles,
        ({ id, role }): Effect.Effect<Measured> => {
          const metric = metrics.get(id);
          const error = metric === undefined ? `Metric ${id} no longer exists` : problem(metric);
          if (metric === undefined || error !== null) return Effect.succeed({ id, role, error: error ?? "" });
          return source.moments(metric, experiment.stats.cuped).pipe(
            Effect.map((rows): Measured => ({ id, role, metric, rows })),
            Effect.catchTag("WarehouseError", (e) => Effect.succeed<Measured>({ id, role, error: e.message })),
          );
        },
        { concurrency: 4 },
      );
      return { health, metrics: analyzeMetrics(measured, experiment) };
    });

    return {
      refresh: Effect.fn("ExperimentAnalysisService.refresh")(function* (experimentId: string) {
        const experiment = yield* loadExperiment(experimentId);
        const phaseIndex = experiment.phases.length - 1;
        const phase = experiment.phases[phaseIndex];
        if (phase === undefined) return yield* new ValidationError({ message: "Start the experiment to see results" });
        const computedAt = new Date();
        const outcome = yield* analyze(experiment, phaseIndex, phase, computedAt).pipe(
          Effect.map((r) => ({ status: "ok" as const, error: null, ...r })),
          Effect.catchTag("WarehouseError", (e) =>
            Effect.succeed({ status: "error" as const, error: e.message, health: null, metrics: [] }),
          ),
        );
        const snapshot = ResultSnapshot.make({ id: crypto.randomUUID(), experimentId, phaseIndex, computedAt, ...outcome });
        yield* database.run("resultSnapshots.insert", (db) =>
          db.insert(resultSnapshots).values({
            id: snapshot.id,
            experimentId,
            phaseIndex,
            computedAt,
            status: snapshot.status,
            error: snapshot.error,
            health: encodeHealth(snapshot.health),
            metrics: encodeMetrics(snapshot.metrics),
          }),
        );
        return snapshot;
      }),

      latest: Effect.fn("ExperimentAnalysisService.latest")(function* (experimentId: string) {
        const experiment = yield* loadExperiment(experimentId);
        const row = yield* database.run("resultSnapshots.latest", (db) =>
          db.query.resultSnapshots.findFirst({
            where: { experimentId, phaseIndex: experiment.phases.length - 1 },
            orderBy: { computedAt: "desc" },
          }),
        );
        return row === undefined ? null : toResultSnapshot(row);
      }),
    };
  }),
);
