import { ChangeRequest, type ExperimentChange, type FlagChange, type FlagState, isExperimentChange } from "@furca/core/approvals/ChangeRequest";
import { ChangeRequestService } from "@furca/core/approvals/ChangeRequestService";
import type { Actor } from "@furca/core/audit/AuditLog";
import { PayloadStore } from "@furca/core/environments/PayloadStore";
import { Feature, FeatureEnvironmentConfig } from "@furca/core/features/Feature";
import type { Experiment } from "@furca/core/experiments/Experiment";
import { ConflictError, ForbiddenError, NotFoundError } from "@furca/core/shared/errors";
import { Database, type Db } from "@furca/database/Database";
import { changeRequests, featureEnvironments, features } from "@furca/database/schema/index";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { flagChangeJson, flagStateJson, rulesJson, toChangeRequest } from "../mappers";
import { publishAll } from "../payload";
import { auditInsert, batch, getFeature, invalid, newId } from "../shared";
import { requireGroups } from "../targeting";
import { emitExperimentEvent, emitFlagUpdated } from "../webhooks";
import { experimentUpdate, makeExperimentOps } from "./ExperimentServiceLive";
import { validateRules } from "./FeatureServiceLive";

const sameState = (a: FlagState, b: FlagState) => JSON.stringify(flagStateJson(a)) === JSON.stringify(flagStateJson(b));

const applied = (base: FlagState, change: FlagChange): FlagState =>
  change.type === "toggle"
    ? { ...base, enabled: change.enabled }
    : change.type === "rules"
      ? { ...base, rules: change.rules }
      : base;

export const ChangeRequestServiceLive = Layer.effect(
  ChangeRequestService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;
    const experimentOps = yield* makeExperimentOps;

    /** The experiment transition a request asks for; fails while it isn't possible (e.g. start of a running experiment) */
    const prepare = (experiment: Experiment, change: ExperimentChange, decidedBy: string, now: Date) => {
      switch (change.type) {
        case "experiment.start":
          return experimentOps.prepareStart(experiment, now);
        case "experiment.traffic":
          return experimentOps.prepareTraffic(experiment, change, now);
        case "experiment.stop":
          return experimentOps.prepareStop(experiment, change, decidedBy, now);
      }
    };

    /**
     * Admins review other people's requests. The author may approve their own only while nobody
     * else can (they are the only owner / admin), with a reason; that approval is audited as
     * `review.selfApproved`. Returns the audit action
     */
    const reviewAction = Effect.fn("ChangeRequestService.reviewAction")(function* (cr: ChangeRequest, actor: Actor, comment: string) {
      if (cr.authorId !== actor.id) return "review.approved";
      const admins = yield* database.run("members.admins", (db) =>
        db.query.user.findMany({ columns: { id: true }, where: { role: { in: ["owner", "admin"] } } }),
      );
      if (admins.some((a) => a.id !== actor.id)) {
        return yield* new ForbiddenError({ message: "You can't approve your own request. Ask another admin" });
      }
      if (comment.trim() === "") {
        return yield* invalid("You are the only admin, so you can approve your own request. Say why in the comment; it is kept in the audit log");
      }
      return "review.selfApproved";
    });

    const load = (id: string) =>
      database
        .run("changeRequests.get", (db) => db.query.changeRequests.findFirst({ where: { id } }))
        .pipe(
          Effect.flatMap((row) =>
            row ? Effect.succeed(toChangeRequest(row)) : Effect.fail(new NotFoundError({ entity: "change request", id })),
          ),
        );

    const loadOpen = (id: string) =>
      load(id).pipe(
        Effect.filterOrFail(
          (cr) => cr.status === "open",
          (cr) => new ConflictError({ message: `This request was already ${cr.status}` }),
        ),
      );

    /** The flag's state in the environment, plus the feature it belongs to */
    const current = (featureId: string, environmentId: string) =>
      getFeature(database, featureId).pipe(
        Effect.flatMap((feature) => {
          const config = feature.environments.find((e) => e.environmentId === environmentId);
          return config
            ? Effect.succeed({ feature, state: { enabled: config.enabled, rules: config.rules } as FlagState })
            : Effect.fail(new NotFoundError({ entity: "environment", id: environmentId }));
        }),
      );

    /** Same checks as a direct save, so nobody approves rules that could not be saved */
    const validate = Effect.fn("ChangeRequestService.validate")(function* (feature: Feature, state: FlagState, change: FlagChange) {
      if (change.type !== "rules") return;
      const error = validateRules(feature, state.rules, change.rules);
      if (error !== null) return yield* invalid(error);
      yield* requireGroups(
        database,
        change.rules.flatMap((rule, i) => (rule._tag === "experiment" ? [] : [{ where: `Rule ${i + 1}`, conditions: rule.conditions }])),
      );
    });

    /** Closes an open request without applying it (rejected / cancelled) */
    const close = Effect.fn("ChangeRequestService.close")(function* (
      id: string,
      status: "rejected" | "cancelled",
      comment: string,
      actor: Actor,
    ) {
      const before = yield* loadOpen(id);
      const now = new Date();
      const after = ChangeRequest.make({
        ...before,
        status,
        reviewerId: actor.id,
        reviewerEmail: actor.email,
        reviewComment: comment.trim(),
        reviewedAt: now,
      });
      yield* database.run(`changeRequests.${status}`, (db) =>
        batch(db, [
          db
            .update(changeRequests)
            .set({ status, reviewerId: actor.id, reviewerEmail: actor.email, reviewComment: after.reviewComment, reviewedAt: now })
            .where(and(eq(changeRequests.id, id), eq(changeRequests.status, "open"))),
          auditInsert(db, { entityType: "feature", entityId: before.featureId, action: `review.${status}`, actor, before, after }),
        ]),
      );
      return after;
    });

    return {
      list: (filter) =>
        database
          .run("changeRequests.list", (db) =>
            db.query.changeRequests.findMany({
              where: { status: filter.status ?? undefined, featureId: filter.featureId ?? undefined },
              orderBy: { createdAt: "desc", id: "desc" },
            }),
          )
          .pipe(Effect.map((rows) => rows.map(toChangeRequest))),

      get: load,

      create: Effect.fn("ChangeRequestService.create")(function* (input, actor) {
        const { feature, state } = yield* current(input.featureId, input.environmentId);
        if (isExperimentChange(input.change)) {
          const experiment = yield* experimentOps.load(input.change.experimentId);
          if (experiment.featureId !== feature.id || !experiment.environmentIds.includes(input.environmentId)) {
            return yield* invalid("The experiment does not run on this flag in this environment");
          }
          // One pending decision per experiment (two tabs, API retries)
          const open = yield* database.run("changeRequests.openForFeature", (db) =>
            db.query.changeRequests.findMany({ where: { featureId: feature.id, status: "open" } }),
          );
          const experimentId = experiment.id;
          if (open.map(toChangeRequest).some((cr) => isExperimentChange(cr.change) && cr.change.experimentId === experimentId)) {
            return yield* new ConflictError({ message: "This experiment already has a pending review request" });
          }
          // Fails now, rather than at approval, when the action isn't possible
          yield* prepare(experiment, input.change, actor.email, new Date());
        } else {
          if (sameState(state, applied(state, input.change))) return yield* invalid("Nothing to review: the flag is already in this state");
          yield* validate(feature, state, input.change);
        }
        const cr = ChangeRequest.make({
          id: newId(),
          featureId: feature.id,
          featureKey: feature.key,
          environmentId: input.environmentId,
          change: input.change,
          base: state,
          comment: input.comment.trim(),
          status: "open",
          authorId: actor.id,
          authorEmail: actor.email,
          reviewerId: null,
          reviewerEmail: null,
          reviewComment: "",
          createdAt: new Date(),
          reviewedAt: null,
        });
        yield* database.run("changeRequests.create", (db) =>
          batch(db, [
            db.insert(changeRequests).values({ ...cr, change: flagChangeJson(cr.change), base: flagStateJson(cr.base) }),
            auditInsert(db, { entityType: "feature", entityId: feature.id, action: "review.requested", actor, before: null, after: cr }),
          ]),
        );
        return cr;
      }),

      approve: Effect.fn("ChangeRequestService.approve")(function* (input, actor) {
        const cr = yield* loadOpen(input.id);
        const reviewed = yield* reviewAction(cr, actor, input.comment);
        const now = new Date();
        const approved = ChangeRequest.make({
          ...cr,
          status: "approved",
          reviewerId: actor.id,
          reviewerEmail: actor.email,
          reviewComment: input.comment.trim(),
          reviewedAt: now,
        });
        const close = (db: Db) => [
          db
            .update(changeRequests)
            .set({ status: "approved", reviewerId: actor.id, reviewerEmail: actor.email, reviewComment: approved.reviewComment, reviewedAt: now })
            .where(eq(changeRequests.id, cr.id)),
          auditInsert(db, { entityType: "feature", entityId: cr.featureId, action: reviewed, actor, before: cr, after: approved }),
        ];

        if (isExperimentChange(cr.change)) {
          const before = yield* experimentOps.load(cr.change.experimentId);
          if (before.updatedAt.getTime() > cr.createdAt.getTime()) {
            return yield* new ConflictError({ message: "The experiment changed since this request; open a new one" });
          }
          // The author made the decision; the approver applies it
          const t = yield* prepare(before, cr.change, cr.authorEmail, now);
          yield* database.run("changeRequests.approve", (db) =>
            batch(db, [
              experimentUpdate(db, before, t.after),
              ...t.writes(db),
              ...close(db),
              auditInsert(db, { entityType: "experiment", entityId: before.id, action: t.action, actor, before, after: t.after }),
            ]),
          );
          yield* publishAll(database, store);
          yield* emitExperimentEvent(t.action, t.after, actor);
          return approved;
        }

        const { feature: before, state } = yield* current(cr.featureId, cr.environmentId);
        // ponytail: read-compare-write, not a conditional UPDATE. Direct edits are blocked in this
        // environment, so only a simultaneous approval or experiment change could slip in between
        if (!sameState(state, cr.base)) return yield* new ConflictError({ message: "The flag changed since this request; open a new one" });
        yield* validate(before, state, cr.change);
        const next = applied(state, cr.change);
        const after = Feature.make({
          ...before,
          updatedAt: now,
          environments: before.environments.map((e) =>
            e.environmentId === cr.environmentId ? FeatureEnvironmentConfig.make({ ...e, ...next }) : e,
          ),
        });
        const action = cr.change.type === "toggle" ? (cr.change.enabled ? "enabled" : "disabled") : "rules.updated";
        yield* database.run("changeRequests.approve", (db) =>
          batch(db, [
            db
              .update(featureEnvironments)
              .set({ enabled: next.enabled, rules: rulesJson(next.rules) })
              .where(and(eq(featureEnvironments.featureId, cr.featureId), eq(featureEnvironments.environmentId, cr.environmentId))),
            db.update(features).set({ updatedAt: now }).where(eq(features.id, cr.featureId)),
            ...close(db),
            // The applied change itself, like a direct save by the approver
            auditInsert(db, { entityType: "feature", entityId: cr.featureId, action, actor, before, after }),
          ]),
        );
        yield* publishAll(database, store);
        yield* emitFlagUpdated(action, before, after, actor);
        return approved;
      }),

      reject: (input, actor) => close(input.id, "rejected", input.comment, actor),

      cancel: (id, actor) => close(id, "cancelled", "", actor),
    };
  }),
);
