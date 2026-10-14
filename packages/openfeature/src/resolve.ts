import type { Attributes, Evaluation } from "@furca/sdk";

export type FlagType = "boolean" | "string" | "number" | "object";

/** OpenFeature ResolutionDetails with the error code as a name; web.ts / server.ts map it to their SDK's ErrorCode */
export interface Resolution<T> {
  value: T;
  reason: "DEFAULT" | "TARGETING_MATCH" | "SPLIT" | "ERROR";
  variant?: string;
  flagMetadata?: Record<string, string>;
  errorCode?: "PROVIDER_NOT_READY" | "FLAG_NOT_FOUND" | "TYPE_MISMATCH";
  errorMessage?: string;
}

const REASONS = { default: "DEFAULT", force: "TARGETING_MATCH", rollout: "SPLIT", experiment: "SPLIT" } as const;

/** OpenFeature's targetingKey is furca's `id` attribute; everything else passes through */
export function toAttributes(context: Readonly<Record<string, unknown>>): Attributes {
  const { targetingKey, ...rest } = context;
  return targetingKey === undefined ? rest : { ...rest, id: targetingKey };
}

export function toResolution<T>(ev: Evaluation, type: FlagType, defaultValue: T, loaded: boolean): Resolution<T> {
  const error = (errorCode: NonNullable<Resolution<T>["errorCode"]>, errorMessage: string): Resolution<T> => ({
    value: defaultValue,
    reason: "ERROR",
    errorCode,
    errorMessage,
  });
  if (!loaded) return error("PROVIDER_NOT_READY", "furca payload is not loaded");
  if (ev.source === "unknown") return error("FLAG_NOT_FOUND", `flag "${ev.key}" is unknown or disabled in this environment`);
  const actual = ev.value === null ? "null" : typeof ev.value; // arrays count as "object"
  if (actual !== type) return error("TYPE_MISMATCH", `flag "${ev.key}" is ${actual}, not ${type}`);
  return {
    value: ev.value as T,
    reason: REASONS[ev.source],
    ...(ev.experiment && { variant: ev.experiment.variationKey, flagMetadata: { experimentKey: ev.experiment.key } }),
  };
}
