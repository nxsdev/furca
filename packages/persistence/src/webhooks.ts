/**
 * Webhook events: emit helpers for the domain services, and the pure parts of a delivery
 * (signature, Slack text)
 */
import type { Actor } from "@furca/core/audit/AuditLog";
import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Feature } from "@furca/core/features/Feature";
import type { WebhookEvent } from "@furca/core/platform/Webhook";
import { type ExperimentEventData, WebhookDispatcher, type WebhookEventData } from "@furca/core/platform/WebhookService";
import { Effect, Option } from "effect";

// ponytail: the dispatcher is read from the running fiber's services (present in every API request),
// so domain layers and their tests need no wiring; a layer without it simply emits nothing
export const emitWebhook = <E extends WebhookEvent>(event: E, data: WebhookEventData[E]): Effect.Effect<void> =>
  Effect.serviceOption(WebhookDispatcher).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (dispatcher) => dispatcher.emit(event, data) })),
  );

/** `flag.updated` for any audited feature change */
export const emitFlagUpdated = (action: string, before: Feature | null, after: Feature | null, actor: Actor) => {
  const feature = after ?? before;
  if (feature === null) return Effect.void;
  const changed =
    before === null || after === null
      ? []
      : after.environments
          .filter((e) => JSON.stringify(e) !== JSON.stringify(before.environments.find((b) => b.environmentId === e.environmentId)))
          .map((e) => e.environmentId);
  return emitWebhook("flag.updated", { flag: { id: feature.id, key: feature.key }, action, environmentIds: changed, actor: actor.email });
};

const experimentEvents: Partial<Record<string, "experiment.started" | "experiment.phase_started" | "experiment.stopped">> = {
  started: "experiment.started",
  "phase.started": "experiment.phase_started",
  stopped: "experiment.stopped",
};

/** experiment.* for the audit actions that start, re-randomize or stop an experiment; other actions emit nothing */
export const emitExperimentEvent = (action: string, e: Experiment, actor: Actor) => {
  const event = experimentEvents[action];
  if (event === undefined) return Effect.void;
  const data: ExperimentEventData = {
    experiment: { id: e.id, key: e.key, name: e.name, status: e.status },
    environmentIds: [...e.environmentIds],
    reason: event === "experiment.stopped" ? (e.decision?.reason ?? "") : (e.phases.at(-1)?.reason ?? ""),
    outcome: event === "experiment.stopped" ? (e.decision?.outcome ?? null) : null,
    variationKey: event === "experiment.stopped" ? (e.decision?.variationKey ?? null) : null,
    actor: actor.email,
  };
  return emitWebhook(event, data);
};

/** `sha256=<hex HMAC-SHA256 of the raw body>`, the `furca-signature` header */
export const signWebhookBody = async (secret: string, body: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

/** Slack mrkdwn control characters */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type WebhookMessage =
  | { readonly [E in WebhookEvent]: { readonly event: E; readonly data: WebhookEventData[E] } }[WebhookEvent]
  | { readonly event: "ping"; readonly data: { readonly webhook: { readonly id: string; readonly name: string } } };

/** One-line Slack message. `environmentName` resolves environment ids */
export const slackText = (message: WebhookMessage, environmentName: (id: string) => string): string => {
  const envs = (ids: ReadonlyArray<string>) => (ids.length === 0 ? "" : ` in ${ids.map((id) => esc(environmentName(id))).join(", ")}`);
  switch (message.event) {
    case "ping":
      return `furca test message: webhook *${esc(message.data.webhook.name)}* is connected`;
    case "payload.updated":
      return `SDK payload updated${envs(message.data.environments.map((e) => e.id))}`;
    case "flag.updated": {
      const { flag, action, environmentIds, actor } = message.data;
      return `Flag \`${esc(flag.key)}\` ${esc(action.replace(".", " "))}${envs(environmentIds)} by ${esc(actor)}`;
    }
    case "experiment.started":
    case "experiment.phase_started":
    case "experiment.stopped": {
      const { experiment, environmentIds, reason, outcome, variationKey, actor } = message.data;
      const name = `Experiment *${esc(experiment.name)}*`;
      const note = reason.trim() === "" ? "" : `: ${esc(reason.trim())}`;
      if (message.event === "experiment.started") return `${name} started${envs(environmentIds)} by ${esc(actor)}`;
      if (message.event === "experiment.phase_started") return `${name} started a new phase${envs(environmentIds)}${note}`;
      const decision = outcome === "ship" ? `shipped \`${esc(variationKey ?? "")}\`` : outcome === "rollback" ? "rolled back" : "stopped without a decision";
      return `${name} ${decision} by ${esc(actor)}${note}`;
    }
  }
};
