import type { Actor } from "@furca/core/audit/AuditLog";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import { ConflictError, NotFoundError } from "@furca/core/shared/errors";
import { SavedGroup } from "@furca/core/targeting/SavedGroup";
import { type SavedGroupInput, SavedGroupService } from "@furca/core/targeting/SavedGroupService";
import { Database } from "@furca/database/Database";
import { savedGroups } from "@furca/database/schema/index";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { toExperiment, toRules, toSavedGroup } from "../mappers";
import { publishAll } from "../payload";
import { auditInsert, batch, invalid, newId } from "../shared";
import { groupIdsOf, isGroupOperator } from "../targeting";

const MAX_VALUES = 10_000;

/** Validated, normalized fields: list groups get trimmed unique values, the unused half of the shape is cleared */
const normalize = (input: SavedGroupInput) =>
  Effect.gen(function* () {
    const name = input.name.trim();
    if (name === "") return yield* invalid("Name is required");
    if (input.type === "condition") {
      if (input.conditions.length === 0) return yield* invalid("Add at least one condition");
      if (input.conditions.some((c) => isGroupOperator(c.operator))) {
        return yield* invalid("A saved group cannot target another saved group");
      }
      if (input.conditions.some((c) => c.attribute.trim() === "")) return yield* invalid("Every condition needs an attribute");
      return { ...input, name, attribute: "", values: [] };
    }
    const attribute = input.attribute.trim();
    if (attribute === "") return yield* invalid("Choose the attribute the list is matched against");
    const values = [...new Set(input.values.map((v) => v.trim()).filter((v) => v !== ""))];
    if (values.length === 0) return yield* invalid("Add at least one value");
    if (values.length > MAX_VALUES) return yield* invalid(`A list can hold at most ${MAX_VALUES.toLocaleString("en-US")} values`);
    return { ...input, name, attribute, values, conditions: [] };
  });

export const SavedGroupServiceLive = Layer.effect(
  SavedGroupService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;

    const load = (id: string) =>
      database
        .run("savedGroups.get", (db) => db.query.savedGroups.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) =>
            row ? Effect.succeed(toSavedGroup(row)) : Effect.fail(new NotFoundError({ entity: "saved group", id })),
          ),
        );

    const columns = (g: SavedGroup) => ({
      name: g.name,
      description: g.description,
      type: g.type,
      conditions: g.conditions.map((c) => ({ attribute: c.attribute, operator: c.operator, values: [...c.values] })),
      attribute: g.attribute,
      values: [...g.values],
      updatedAt: g.updatedAt,
    });

    /** What references the group, as a sentence for the CONFLICT message, or null */
    const usedBy = Effect.fn("SavedGroupService.usedBy")(function* (id: string) {
      const [features, envRows, experiments, groups] = yield* database.run("savedGroups.references", (db) =>
        Promise.all([
          db.query.features.findMany({ columns: { id: true, key: true } }),
          db.query.featureEnvironments.findMany(),
          db.query.experiments.findMany({ where: { status: { in: ["draft", "running"] } } }),
          db.query.savedGroups.findMany({ where: { type: "condition", id: { ne: id } } }),
        ]),
      );
      const flagRow = envRows.find((row) =>
        toRules(row.rules).some((rule) => rule._tag !== "experiment" && groupIdsOf(rule.conditions).includes(id)),
      );
      if (flagRow !== undefined) {
        const key = features.find((f) => f.id === flagRow.featureId)?.key ?? flagRow.featureId;
        return `The flag "${key}" targets this group in its rules`;
      }
      const experiment = experiments.map(toExperiment).find((e) => groupIdsOf(e.conditions).includes(id));
      if (experiment !== undefined) return `The experiment "${experiment.name}" targets this group`;
      const group = groups.map(toSavedGroup).find((g) => groupIdsOf(g.conditions).includes(id));
      if (group !== undefined) return `The saved group "${group.name}" references this group`;
      return null;
    });

    const write = (action: string, actor: Actor, before: SavedGroup | null, after: SavedGroup) =>
      database.run(`savedGroups.${action}`, (db) =>
        batch(db, [
          before === null
            ? db.insert(savedGroups).values({ ...columns(after), id: after.id, key: after.key, createdAt: after.createdAt })
            : db.update(savedGroups).set(columns(after)).where(eq(savedGroups.id, after.id)),
          auditInsert(db, { entityType: "savedGroup", entityId: after.id, action, actor, before, after }),
        ]),
      );

    return {
      list: database
        .run("savedGroups.list", (db) => db.query.savedGroups.findMany({ orderBy: { name: "asc" } }))
        .pipe(Effect.map((rows) => rows.map(toSavedGroup))),

      get: load,

      create: Effect.fn("SavedGroupService.create")(function* (input, actor) {
        const { key, ...fields } = input;
        const valid = yield* normalize(fields);
        const existing = yield* database.run("savedGroups.byKey", (db) => db.query.savedGroups.findFirst({ where: { key } }));
        if (existing !== undefined) return yield* invalid(`A saved group with key "${key}" already exists`);
        const now = new Date();
        const group = SavedGroup.make({ ...valid, id: newId(), key, createdAt: now, updatedAt: now });
        // Nothing references a new group yet: payloads do not change
        yield* write("created", actor, null, group);
        return group;
      }),

      update: Effect.fn("SavedGroupService.update")(function* (input, actor) {
        const { id, ...fields } = input;
        const before = yield* load(id);
        const valid = yield* normalize(fields);
        const after = SavedGroup.make({ ...before, ...valid, updatedAt: new Date() });
        yield* write("updated", actor, before, after);
        yield* publishAll(database, store);
        return after;
      }),

      delete: Effect.fn("SavedGroupService.delete")(function* (id, actor) {
        const before = yield* load(id);
        const reference = yield* usedBy(id);
        if (reference !== null) return yield* new ConflictError({ message: `${reference}. Remove it there before deleting the group` });
        yield* database.run("savedGroups.delete", (db) =>
          batch(db, [
            db.delete(savedGroups).where(eq(savedGroups.id, id)),
            auditInsert(db, { entityType: "savedGroup", entityId: id, action: "deleted", actor, before, after: null }),
          ]),
        );
      }),
    };
  }),
);
