import { evaluate, type FurcaClient, fetchPayload, type SdkPayload } from "@furca/sdk";
import { ErrorCode, type EvaluationContext, type JsonValue, type Provider, type ResolutionDetails } from "@openfeature/server-sdk";
import { type FlagType, toAttributes, toResolution } from "./resolve.ts";

export type FurcaServerProviderOptions =
  /** Payload (and its refreshes) from a long-lived client; experiment exposures are recorded per evaluated user */
  | { client: FurcaClient }
  /** Fetches and caches the payload itself. Evaluation only: exposures are not recorded, pass `client` for that */
  | {
      apiHost: string;
      sdkKey: string;
      fetch?: (input: string, init?: RequestInit) => Promise<Response>;
      /** Payload cache lifetime in ms; a stale copy is served while it refreshes. Default 30000 */
      cacheTtl?: number;
    };

/** OpenFeature server provider (dynamic context): every call evaluates its own context locally */
export class FurcaServerProvider implements Provider {
  readonly metadata = { name: "furca" } as const;
  readonly runsOn = "server";
  private payload: SdkPayload | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | undefined;

  constructor(private readonly options: FurcaServerProviderOptions) {}

  async initialize(): Promise<void> {
    if ("client" in this.options) await this.options.client.ready();
    if (!(await this.currentPayload())) throw new Error("[furca] could not load the payload");
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext): Promise<ResolutionDetails<boolean>> {
    return this.resolve(flagKey, "boolean", defaultValue, context);
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext): Promise<ResolutionDetails<string>> {
    return this.resolve(flagKey, "string", defaultValue, context);
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext): Promise<ResolutionDetails<number>> {
    return this.resolve(flagKey, "number", defaultValue, context);
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext): Promise<ResolutionDetails<T>> {
    return this.resolve(flagKey, "object", defaultValue, context);
  }

  private async currentPayload(): Promise<SdkPayload | null> {
    const o = this.options;
    if ("client" in o) return o.client.getPayload();
    if (Date.now() - this.loadedAt >= (o.cacheTtl ?? 30_000)) {
      this.loading ??= fetchPayload(o)
        .then(
          (p) => void (this.payload = p),
          (e) => console.warn("[furca] payload refresh failed; keeping the last copy", e),
        )
        .finally(() => {
          this.loadedAt = Date.now(); // failures also wait a TTL before retrying
          this.loading = undefined;
        });
      if (!this.payload) await this.loading; // stale-while-revalidate once something is cached
    }
    return this.payload;
  }

  private async resolve<T>(flagKey: string, type: FlagType, defaultValue: T, context: EvaluationContext): Promise<ResolutionDetails<T>> {
    const payload = await this.currentPayload();
    const attributes = toAttributes(context);
    const ev = "client" in this.options ? this.options.client.evaluate(flagKey, attributes) : evaluate(payload, flagKey, attributes);
    const r = toResolution(ev, type, defaultValue, payload !== null);
    return { ...r, errorCode: r.errorCode && ErrorCode[r.errorCode] };
  }
}
