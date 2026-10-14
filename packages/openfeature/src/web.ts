import type { FurcaClient } from "@furca/sdk";
import {
  ErrorCode,
  type EvaluationContext,
  type JsonValue,
  OpenFeatureEventEmitter,
  type Provider,
  ProviderEvents,
  type ResolutionDetails,
} from "@openfeature/web-sdk";
import { type FlagType, toAttributes, toResolution } from "./resolve.ts";

/**
 * OpenFeature web provider (static context): the evaluation context becomes the client's attributes,
 * flags are evaluated locally and exposures are recorded by the client
 */
export class FurcaWebProvider implements Provider {
  readonly metadata = { name: "furca" } as const;
  readonly runsOn = "client";
  readonly events = new OpenFeatureEventEmitter();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly client: FurcaClient) {}

  async initialize(context?: EvaluationContext): Promise<void> {
    if (context) this.client.setAttributes(toAttributes(context));
    await this.client.ready();
    let last = this.client.getPayload();
    this.unsubscribe = this.client.subscribe((payload) => {
      if (payload === last) return; // attributes changed, not the flags
      this.events.emit(last ? ProviderEvents.ConfigurationChanged : ProviderEvents.Ready); // Ready recovers from ERROR
      last = payload;
    });
    if (!last) throw new Error("[furca] could not load the payload; serving defaults until a refresh succeeds");
  }

  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): void {
    this.client.setAttributes(toAttributes(newContext));
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean): ResolutionDetails<boolean> {
    return this.resolve(flagKey, "boolean", defaultValue);
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string): ResolutionDetails<string> {
    return this.resolve(flagKey, "string", defaultValue);
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number): ResolutionDetails<number> {
    return this.resolve(flagKey, "number", defaultValue);
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T): ResolutionDetails<T> {
    return this.resolve(flagKey, "object", defaultValue);
  }

  private resolve<T>(flagKey: string, type: FlagType, defaultValue: T): ResolutionDetails<T> {
    const r = toResolution(this.client.evaluate(flagKey), type, defaultValue, this.client.getPayload() !== null);
    return { ...r, errorCode: r.errorCode && ErrorCode[r.errorCode] };
  }
}
