import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { Condition } from "../targeting/Condition";
import type { DecisionOutcome, Experiment } from "./Experiment";

/** Everything editable on a draft */
export type ExperimentDraft = Pick<
  Experiment,
  | "name"
  | "hypothesis"
  | "featureId"
  | "environmentIds"
  | "analysisEnvironmentId"
  | "hashAttribute"
  | "variations"
  | "coverage"
  | "weights"
  | "conditions"
  | "dataSourceId"
  | "primaryMetricId"
  | "secondaryMetricIds"
  | "guardrailMetricIds"
  | "stats"
  | "plan"
>;

export interface TrafficChange {
  readonly coverage: number;
  readonly weights: ReadonlyArray<number>;
  readonly conditions: ReadonlyArray<Condition>;
  /** Recorded on the new phase when the change re-randomizes */
  readonly reason: string;
}

type Errors = NotFoundError | ValidationError | PersistenceError;
type Id = { readonly id: string };

/** Experiment lifecycle draft -> running -> stopped. The experiment owns its rule in the flag */
export interface ExperimentServiceShape {
  /** Newest first */
  readonly list: (includeArchived: boolean) => Effect.Effect<ReadonlyArray<Experiment>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<Experiment, NotFoundError | PersistenceError>;
  /** Draft; its rule goes to the top of the flag's rules in each selected environment */
  readonly create: (input: ExperimentDraft & { readonly key: string }, actor: Actor) => Effect.Effect<Experiment, Errors>;
  /** Draft: everything. Started: only name, hypothesis, secondary and guardrail metrics */
  readonly update: (input: Id & ExperimentDraft, actor: Actor) => Effect.Effect<Experiment, Errors>;
  /** Opens phase 0 with a fresh seed */
  readonly start: (id: string, actor: Actor) => Effect.Effect<Experiment, Errors>;
  /** Raising coverage edits the current phase; anything else opens a new phase with a new seed */
  readonly updateTraffic: (input: Id & TrafficChange, actor: Actor) => Effect.Effect<Experiment, Errors>;
  /** ship turns the rule into a force rule serving the variation; otherwise the rule is removed */
  readonly stop: (
    input: Id & { readonly outcome: DecisionOutcome; readonly variationKey: string | null; readonly reason: string },
    actor: Actor,
  ) => Effect.Effect<Experiment, Errors>;
  readonly archive: (input: Id & { readonly archived: boolean }, actor: Actor) => Effect.Effect<Experiment, Errors>;
  /** Drafts only */
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, Errors>;
}

export class ExperimentService extends Context.Service<ExperimentService, ExperimentServiceShape>()(
  "kuji/ExperimentService",
) {}
