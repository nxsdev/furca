import { Context, type Effect } from "effect";
import type { Actor } from "../audit/AuditLog";
import type { DecisionOutcome } from "../experiments/Experiment";
import type { NotFoundError, PersistenceError, ValidationError } from "../shared/errors";
import type { Webhook, WebhookEvent, WebhookFormat } from "./Webhook";

export interface WebhookInput {
  readonly name: string;
  readonly url: string;
  readonly format: WebhookFormat;
  readonly events: ReadonlyArray<WebhookEvent>;
}

export interface WebhookServiceShape {
  /** Oldest first */
  readonly list: Effect.Effect<ReadonlyArray<Webhook>, PersistenceError>;
  /** The signing secret is returned here and never again (stored encrypted) */
  readonly create: (
    input: WebhookInput,
    actor: Actor,
  ) => Effect.Effect<{ readonly webhook: Webhook; readonly secret: string }, ValidationError | PersistenceError>;
  readonly update: (
    input: WebhookInput & { readonly id: string; readonly enabled: boolean },
    actor: Actor,
  ) => Effect.Effect<Webhook, NotFoundError | ValidationError | PersistenceError>;
  readonly delete: (id: string, actor: Actor) => Effect.Effect<void, NotFoundError | PersistenceError>;
  /** Sends a signed `ping` now (even when disabled) and records the outcome */
  readonly test: (
    id: string,
  ) => Effect.Effect<{ readonly status: number | null; readonly error: string | null }, NotFoundError | ValidationError | PersistenceError>;
}

export class WebhookService extends Context.Service<WebhookService, WebhookServiceShape>()("furca/WebhookService") {}

export interface ExperimentEventData {
  readonly experiment: { readonly id: string; readonly key: string; readonly name: string; readonly status: string };
  readonly environmentIds: ReadonlyArray<string>;
  /** Phase reason (started / phase_started) or the decision note (stopped) */
  readonly reason: string;
  /** stopped only */
  readonly outcome: DecisionOutcome | null;
  readonly variationKey: string | null;
  /** Email of the member, or `api-key:<name>` */
  readonly actor: string;
}

/** `data` of each event's JSON body */
export interface WebhookEventData {
  readonly "payload.updated": { readonly environments: ReadonlyArray<{ readonly id: string; readonly key: string }> };
  readonly "flag.updated": {
    readonly flag: { readonly id: string; readonly key: string };
    /** Audit action: created, updated, enabled, disabled, rules.updated, archived, unarchived, deleted */
    readonly action: string;
    /** Environments whose state or rules changed */
    readonly environmentIds: ReadonlyArray<string>;
    readonly actor: string;
  };
  readonly "experiment.started": ExperimentEventData;
  readonly "experiment.phase_started": ExperimentEventData;
  readonly "experiment.stopped": ExperimentEventData;
}

/** Fans domain events out to subscribed webhooks */
export interface WebhookDispatcherShape {
  /** Delivers to every enabled webhook subscribed to `event`, in the background. Never fails */
  readonly emit: <E extends WebhookEvent>(event: E, data: WebhookEventData[E]) => Effect.Effect<void>;
}

export class WebhookDispatcher extends Context.Service<WebhookDispatcher, WebhookDispatcherShape>()("furca/WebhookDispatcher") {}
