/**
 * Wire format served at GET /api/sdk/v1/payload/:sdkKey and evaluated locally by the SDK.
 * Dependency-free on purpose: the server imports these types to build the payload
 */

export type ConditionOperator =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "semver_gt"
  | "semver_gte"
  | "semver_lt"
  | "semver_lte"
  | "exists"
  | "not_exists";

export interface PayloadCondition {
  readonly attribute: string;
  readonly operator: ConditionOperator;
  readonly values: ReadonlyArray<string>;
}

export interface ForcePayloadRule {
  readonly type: "force";
  readonly conditions: ReadonlyArray<PayloadCondition>;
  readonly value: unknown;
}

export interface RolloutPayloadRule {
  readonly type: "rollout";
  readonly conditions: ReadonlyArray<PayloadCondition>;
  readonly value: unknown;
  /** 0..1 */
  readonly coverage: number;
  readonly hashAttribute: string;
  readonly seed: string;
}

export interface ExperimentPayloadRule {
  readonly type: "experiment";
  /** Experiment tracking key, sent with exposures */
  readonly key: string;
  readonly conditions: ReadonlyArray<PayloadCondition>;
  /** 0..1 share of matching users that enter */
  readonly coverage: number;
  readonly hashAttribute: string;
  readonly seed: string;
  /** Current phase index, sent with exposures (a new phase re-randomizes and re-counts users) */
  readonly phase: number;
  /** Index 0 is the control */
  readonly variations: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  /** Same length as variations, sums to 1 */
  readonly weights: ReadonlyArray<number>;
}

export type PayloadRule = ForcePayloadRule | RolloutPayloadRule | ExperimentPayloadRule;

export interface PayloadFeature {
  readonly defaultValue: unknown;
  readonly rules: ReadonlyArray<PayloadRule>;
}

export interface SdkPayload {
  readonly version: 1;
  readonly environment: string;
  /** ISO timestamp */
  readonly generatedAt: string;
  /** Only features enabled in this environment are present */
  readonly features: Readonly<Record<string, PayloadFeature>>;
}

export type Attributes = Readonly<Record<string, unknown>>;

export type EvaluationSource =
  /** Feature missing from the payload (unknown key or disabled in this environment) */
  | "unknown"
  | "default"
  | "force"
  | "rollout"
  | "experiment";

export interface Evaluation<T = unknown> {
  readonly key: string;
  readonly value: T | null;
  readonly source: EvaluationSource;
  /** Index of the matched rule, or -1 */
  readonly ruleIndex: number;
  /** Set when the user was assigned to an experiment variation */
  readonly experiment: { readonly key: string; readonly variationKey: string } | null;
}

/** POST /api/sdk/v1/events/:sdkKey body. text/plain is accepted too, for sendBeacon */
export interface EventsBody {
  readonly exposures?: ReadonlyArray<{
    readonly experimentKey: string;
    readonly variationKey: string;
    /** Experiment phase index from the payload rule. Defaults to 0 */
    readonly phase?: number;
    /** Value of the experiment's hash attribute */
    readonly userId: string;
    /** epoch ms */
    readonly ts: number;
  }>;
  readonly events?: ReadonlyArray<{
    readonly name: string;
    /** Value of the `id` attribute */
    readonly userId: string;
    readonly value?: number | null;
    /** epoch ms */
    readonly ts: number;
  }>;
}
