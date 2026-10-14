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
  | "not_exists"
  /** values[0] is a key of SdkPayload.savedGroups; attribute is ignored */
  | "in_group"
  | "not_in_group";

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
  /**
   * Mutual exclusion: [namespace key, start, end). The user enters only if
   * GrowthBook's v1 hash of ("__" + key, hash attribute value) falls in [start, end)
   */
  readonly namespace?: readonly [key: string, start: number, end: number];
  /** Attribute names whose values are sent with this experiment's exposures (for breakdowns) */
  readonly dimensions?: ReadonlyArray<string>;
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

export type PayloadSavedGroup =
  | { readonly type: "list"; readonly attribute: string; readonly values: ReadonlyArray<string> }
  | { readonly type: "condition"; readonly conditions: ReadonlyArray<PayloadCondition> };

export interface SdkPayload {
  readonly version: 1;
  readonly environment: string;
  /** ISO timestamp */
  readonly generatedAt: string;
  /** Only features enabled in this environment are present */
  readonly features: Readonly<Record<string, PayloadFeature>>;
  /** Saved groups referenced by in_group / not_in_group conditions, keyed by group id */
  readonly savedGroups?: Readonly<Record<string, PayloadSavedGroup>>;
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
    /** Values of the experiment rule's `dimensions` attributes at exposure time (strings, max 100 chars) */
    readonly dimensions?: Readonly<Record<string, string>>;
    /** epoch ms */
    readonly ts: number;
  }>;
  readonly events?: ReadonlyArray<{
    readonly name: string;
    /** Value of the `id` attribute */
    readonly userId: string;
    readonly value?: number | null;
    /** Flat properties for metric filters, e.g. { plan: "pro" }. Max 20 keys, string values max 200 chars */
    readonly properties?: Readonly<Record<string, string | number | boolean>>;
    /** epoch ms */
    readonly ts: number;
  }>;
}
