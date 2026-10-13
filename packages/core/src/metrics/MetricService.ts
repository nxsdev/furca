import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { Metric } from "./Metric";

export type MetricInput = Pick<
  Metric,
  "name" | "description" | "type" | "dataSourceId" | "definition" | "inverse" | "windowHours" | "delayHours" | "capping"
>;

type Errors = NotFoundError | ValidationError | PersistenceError;

export interface MetricServiceShape {
  readonly list: (includeArchived: boolean) => Effect.Effect<ReadonlyArray<Metric>, PersistenceError>;
  readonly get: (id: string) => Effect.Effect<Metric, NotFoundError | PersistenceError>;
  readonly create: (input: MetricInput & { readonly key: string }, actor: Actor) => Effect.Effect<Metric, Errors>;
  readonly update: (input: MetricInput & { readonly id: string }, actor: Actor) => Effect.Effect<Metric, Errors>;
  readonly archive: (input: { readonly id: string; readonly archived: boolean }, actor: Actor) => Effect.Effect<Metric, Errors>;
}

export class MetricService extends Context.Service<MetricService, MetricServiceShape>()("kuji/MetricService") {}
