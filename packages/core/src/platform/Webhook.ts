import { Schema } from "effect";

export const WebhookEvent = Schema.Literals([
  /** Any change to what SDKs receive (flags, experiments, environments, saved groups) */
  "payload.updated",
  "flag.updated",
  "experiment.started",
  "experiment.phase_started",
  "experiment.stopped",
]);
export type WebhookEvent = typeof WebhookEvent.Type;

/** json: signed JSON body for your services; slack: a Slack incoming-webhook message */
export const WebhookFormat = Schema.Literals(["json", "slack"]);
export type WebhookFormat = typeof WebhookFormat.Type;

export class Webhook extends Schema.Class<Webhook>("Webhook")({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  format: WebhookFormat,
  events: Schema.Array(WebhookEvent),
  enabled: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  lastDeliveredAt: Schema.NullOr(Schema.Date),
  /** HTTP status of the last delivery attempt, null if it never reached the server */
  lastStatus: Schema.NullOr(Schema.Int),
  lastError: Schema.NullOr(Schema.String),
}) {}
