import type { Actor } from "@furca/core/audit/AuditLog";
import { type EventSource, Metric, MetricCapping, MetricDefinition } from "@furca/core/metrics/Metric";
import { type MetricInput, MetricService } from "@furca/core/metrics/MetricService";
import { type Issue, issue, NotFoundError, ValidationError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { metrics } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { toMetric } from "../mappers";
import { auditInsert, batch, invalid, newId } from "../shared";

const MAX_FILTERS = 10;

/** Problem with an event source's property filters, or null. Values per operator: see PropertyFilter */
export const filtersProblem = (source: EventSource): Issue | null => {
  if (source.filters.length > MAX_FILTERS) return issue("metric.tooManyFilters", { max: MAX_FILTERS });
  for (const f of source.filters) {
    const name = f.property.trim();
    if (name === "") return issue("metric.filterPropertyRequired");
    const property = { property: name };
    if (/["\\]/.test(name)) return issue("metric.filterPropertyName", property);
    const { values } = f;
    if (f.operator === "exists" || f.operator === "not_exists") {
      if (values.length > 0) return issue("metric.filterNoValue", property);
      continue;
    }
    if (values.some((v) => v === "")) return issue("metric.filterValueRequired", property);
    if (f.operator === "in" || f.operator === "not_in") {
      if (values.length === 0) return issue("metric.filterValuesRequired", property);
      continue;
    }
    if (values.length !== 1) return issue("metric.filterOneValue", property);
    if (["gt", "gte", "lt", "lte"].includes(f.operator) && !Number.isFinite(Number(values[0]))) {
      return issue("metric.filterNumber", property);
    }
  }
  return null;
};

const columns = (m: Metric) => ({
  name: m.name,
  description: m.description,
  type: m.type,
  dataSourceId: m.dataSourceId,
  definition: Schema.encodeSync(MetricDefinition)(m.definition),
  inverse: m.inverse,
  windowHours: m.windowHours,
  delayHours: m.delayHours,
  capping: Schema.encodeSync(MetricCapping)(m.capping),
  updatedAt: m.updatedAt,
});

export const MetricServiceLive = Layer.effect(
  MetricService,
  Effect.gen(function* () {
    const database = yield* Database;

    const load = (id: string) =>
      database
        .run("metrics.get", (db) => db.query.metrics.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) => (row ? Effect.succeed(toMetric(row)) : Effect.fail(new NotFoundError({ entity: "metric", id })))),
        );

    const validate = Effect.fn("MetricService.validate")(function* (input: MetricInput) {
      if (input.name.trim() === "") return yield* invalid("common.nameRequired", undefined, "name");
      const source = yield* database.run("dataSources.get", (db) =>
        db.query.dataSources.findFirst({ where: { id: input.dataSourceId } }),
      );
      if (source === undefined) return yield* invalid("dataSource.gone", undefined, "dataSourceId");
      const definition = input.definition;
      const expected = source.type === "builtin" ? "event" : "sql";
      if (definition._tag !== expected) {
        return yield* invalid(source.type === "builtin" ? "metric.eventDefinition" : "metric.sqlDefinition");
      }
      const hasDenominator = definition._tag === "event" ? definition.denominator !== null : definition.denominatorSql !== null;
      if (input.type === "ratio" && !hasDenominator) return yield* invalid("metric.denominatorRequired");
      if (input.type !== "ratio" && hasDenominator) return yield* invalid("metric.denominatorRatioOnly");
      if (definition._tag === "event") {
        if (definition.numerator.event.trim() === "" || definition.denominator?.event.trim() === "") {
          return yield* invalid("metric.eventRequired");
        }
        const problem = filtersProblem(definition.numerator) ?? (definition.denominator && filtersProblem(definition.denominator));
        if (problem) return yield* new ValidationError(problem);
      } else if (definition.numeratorSql.trim() === "" || definition.denominatorSql?.trim() === "") {
        return yield* invalid("metric.sqlRequired");
      }
      if (input.windowHours !== null && !(input.windowHours > 0)) return yield* invalid("metric.windowPositive", undefined, "window");
      if (!(input.delayHours >= 0)) return yield* invalid("metric.delayNegative");
      if (input.capping.type === "absolute" && !(input.capping.value > 0)) return yield* invalid("metric.capPositive", undefined, "capAbsolute");
      if (input.capping.type === "percentile" && !(input.capping.value > 0 && input.capping.value < 1)) {
        return yield* invalid("metric.capPercentile", undefined, "capPercentile");
      }
    });

    const write = (action: string, actor: Actor, before: Metric | null, after: Metric) =>
      database.run(`metrics.${action}`, (db) =>
        batch(db, [
          before === null
            ? db.insert(metrics).values({ ...columns(after), id: after.id, key: after.key, createdAt: after.createdAt })
            : db
                .update(metrics)
                .set({
                  ...columns(after),
                  ...(before.archived === after.archived ? {} : { archivedAt: after.archived ? after.updatedAt : null }),
                })
                .where(eq(metrics.id, after.id)),
          auditInsert(db, { entityType: "metric", entityId: after.id, action, actor, before, after }),
        ]),
      );

    return {
      list: (includeArchived) =>
        database
          .run("metrics.list", (db) =>
            db.query.metrics.findMany({ where: includeArchived ? {} : { archivedAt: { isNull: true } }, orderBy: { key: "asc" } }),
          )
          .pipe(Effect.map((rows) => rows.map(toMetric))),

      get: load,

      create: Effect.fn("MetricService.create")(function* (input, actor) {
        const { key, ...fields } = input;
        yield* validate(fields);
        const existing = yield* database.run("metrics.byKey", (db) => db.query.metrics.findFirst({ where: { key } }));
        if (existing !== undefined) return yield* invalid("metric.keyTaken", { key }, "key");
        const now = new Date();
        const metric = Metric.make({ ...fields, id: newId(), key, archived: false, createdAt: now, updatedAt: now });
        yield* write("created", actor, null, metric);
        return metric;
      }),

      update: Effect.fn("MetricService.update")(function* (input, actor) {
        const { id, ...fields } = input;
        const before = yield* load(id);
        yield* validate(fields);
        const after = Metric.make({ ...before, ...fields, updatedAt: new Date() });
        yield* write("updated", actor, before, after);
        return after;
      }),

      archive: Effect.fn("MetricService.archive")(function* (input, actor) {
        const before = yield* load(input.id);
        const after = Metric.make({ ...before, archived: input.archived, updatedAt: new Date() });
        yield* write(input.archived ? "archived" : "unarchived", actor, before, after);
        return after;
      }),
    };
  }),
);
