/**
 * Admin API contract (oRPC v2, contract-first), shared by the Worker and the browser bundle.
 * Inputs are Effect Schemas (validated on the server through Standard Schema); outputs are typed
 * only. Keep this file free of server-only imports (D1, better-auth server, node APIs)
 *
 * Errors use standard oRPC codes: UNAUTHORIZED, FORBIDDEN, NOT_FOUND, BAD_REQUEST, CONFLICT,
 * BAD_GATEWAY (warehouse failures), INTERNAL_SERVER_ERROR. `message` is always safe to display
 */
import type { AuditLog } from "@kuji/core/audit/AuditLog";
import { AuditEntityType } from "@kuji/core/audit/AuditLog";
import { BigQueryConfig, type DataSource } from "@kuji/core/datasources/DataSource";
import type { Environment } from "@kuji/core/environments/Environment";
import {
  DecisionOutcome,
  type Experiment,
  ExperimentPlan,
  StatsSettings,
  Variation,
} from "@kuji/core/experiments/Experiment";
import { type Feature, FeatureRule, FeatureValueType } from "@kuji/core/features/Feature";
import type { Invitation, Member } from "@kuji/core/members/Member";
import { type Metric, MetricCapping, MetricDefinition, MetricType } from "@kuji/core/metrics/Metric";
import type { ResultSnapshot } from "@kuji/core/results/ExperimentResult";
import { Condition } from "@kuji/core/targeting/Condition";
import { oc, type } from "@orpc/contract";
import { toStandardSchema } from "@orpc/experimental-effect";
import { Schema } from "effect";

/** Input fields must decode without Effect services so the schema can run as Standard Schema */
type InputFields = { readonly [key: string]: Schema.Top & { readonly DecodingServices: never } };
const input = <const Fields extends InputFields>(fields: Fields) => toStandardSchema(Schema.Struct(fields));

/** lowercase letters, digits, - and _; used for feature / experiment / metric / environment keys */
export const Key = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
    message: "Use lowercase letters, digits, - and _ (max 64)",
  }),
);

const Id = { id: Schema.String };

export interface EnvironmentListItem {
  readonly environment: Environment;
  /** Size of the SDK payload in KV, null if never published */
  readonly payloadBytes: number | null;
  readonly featureCount: number;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
  /** BigQuery dry-run estimate of the exposure query */
  readonly bytesProcessed: number | null;
}

export interface EventNameStat {
  readonly name: string;
  readonly count: number;
  readonly lastSeenAt: Date;
}

export interface VolumeBucket {
  /** Start of the UTC hour */
  readonly hour: Date;
  readonly exposures: number;
  readonly events: number;
}

/** Everything editable on a draft experiment */
export const ExperimentDraftFields = {
  name: Schema.String,
  hypothesis: Schema.String,
  featureId: Schema.String,
  environmentIds: Schema.Array(Schema.String),
  analysisEnvironmentId: Schema.String,
  hashAttribute: Schema.String,
  variations: Schema.Array(Variation),
  coverage: Schema.Finite,
  weights: Schema.Array(Schema.Finite),
  conditions: Schema.Array(Condition),
  dataSourceId: Schema.String,
  primaryMetricId: Schema.NullOr(Schema.String),
  secondaryMetricIds: Schema.Array(Schema.String),
  guardrailMetricIds: Schema.Array(Schema.String),
  stats: StatsSettings,
  plan: ExperimentPlan,
};

export const MetricFields = {
  name: Schema.String,
  description: Schema.String,
  type: MetricType,
  dataSourceId: Schema.String,
  definition: MetricDefinition,
  inverse: Schema.Boolean,
  windowHours: Schema.NullOr(Schema.Finite),
  delayHours: Schema.Finite,
  capping: MetricCapping,
};

export const contract = {
  /** No session required: first-run setup and invitation lookup */
  public: {
    /** needsSetup is true until the first (owner) account exists */
    setupStatus: oc.output(type<{ needsSetup: boolean }>()),
    /** Email the invitation was created for; NOT_FOUND when expired or used */
    invitation: oc.input(input({ token: Schema.String })).output(type<{ email: string }>()),
  },

  session: {
    me: oc.output(type<Member>()),
  },

  environments: {
    list: oc.output(type<ReadonlyArray<EnvironmentListItem>>()),
    create: oc.input(input({ key: Key, name: Schema.String })).output(type<Environment>()),
    update: oc.input(input({ ...Id, name: Schema.String })).output(type<Environment>()),
    rotateSdkKey: oc.input(input(Id)).output(type<Environment>()),
    /** CONFLICT while experiments run in it; the last environment cannot be deleted */
    delete: oc.input(input(Id)).output(type<void>()),
    /** The exact JSON the SDK receives (pretty-printed), for debugging delivery */
    payload: oc.input(input(Id)).output(type<string>()),
  },

  features: {
    list: oc.input(input({ includeArchived: Schema.Boolean })).output(type<ReadonlyArray<Feature>>()),
    get: oc.input(input(Id)).output(type<Feature>()),
    create: oc
      .input(
        input({
          key: Key,
          description: Schema.String,
          valueType: FeatureValueType,
          defaultValue: Schema.String,
          tags: Schema.Array(Schema.String),
        }),
      )
      .output(type<Feature>()),
    update: oc
      .input(input({ ...Id, description: Schema.String, defaultValue: Schema.String, tags: Schema.Array(Schema.String) }))
      .output(type<Feature>()),
    setEnabled: oc
      .input(input({ ...Id, environmentId: Schema.String, enabled: Schema.Boolean }))
      .output(type<Feature>()),
    /**
     * Replaces the ordered rules of one environment. Experiment rules may be reordered or
     * toggled but not added / removed here (experiments own them)
     */
    saveRules: oc
      .input(input({ ...Id, environmentId: Schema.String, rules: Schema.Array(FeatureRule) }))
      .output(type<Feature>()),
    archive: oc.input(input({ ...Id, archived: Schema.Boolean })).output(type<Feature>()),
    /** CONFLICT when experiments reference the feature */
    delete: oc.input(input(Id)).output(type<void>()),
  },

  experiments: {
    list: oc.input(input({ includeArchived: Schema.Boolean })).output(type<ReadonlyArray<Experiment>>()),
    get: oc.input(input(Id)).output(type<Experiment>()),
    /** Creates a draft and inserts its experiment rule at the top of each environment's rules */
    create: oc.input(input({ key: Key, ...ExperimentDraftFields })).output(type<Experiment>()),
    /**
     * Draft: every field. Running / stopped: only name, hypothesis, secondary and guardrail
     * metrics may change (anything else fails BAD_REQUEST)
     */
    update: oc.input(input({ ...Id, ...ExperimentDraftFields })).output(type<Experiment>()),
    /** draft -> running: opens phase 0 with a fresh seed. Requires a primary metric */
    start: oc.input(input(Id)).output(type<Experiment>()),
    /**
     * Running only. Raising coverage edits the current phase; any other change closes it and
     * opens a new phase with a new seed (re-randomization), recording `reason`
     */
    updateTraffic: oc
      .input(
        input({
          ...Id,
          coverage: Schema.Finite,
          weights: Schema.Array(Schema.Finite),
          conditions: Schema.Array(Condition),
          reason: Schema.String,
        }),
      )
      .output(type<Experiment>()),
    /**
     * running -> stopped with a decision. ship: the experiment rule becomes a force rule serving
     * the chosen variation (same conditions). rollback / inconclusive: the rule is removed
     */
    stop: oc
      .input(
        input({
          ...Id,
          outcome: DecisionOutcome,
          variationKey: Schema.NullOr(Schema.String),
          reason: Schema.String,
        }),
      )
      .output(type<Experiment>()),
    archive: oc.input(input({ ...Id, archived: Schema.Boolean })).output(type<Experiment>()),
    /** Drafts only */
    delete: oc.input(input(Id)).output(type<void>()),
  },

  metrics: {
    list: oc.input(input({ includeArchived: Schema.Boolean })).output(type<ReadonlyArray<Metric>>()),
    get: oc.input(input(Id)).output(type<Metric>()),
    create: oc.input(input({ key: Key, ...MetricFields })).output(type<Metric>()),
    update: oc.input(input({ ...Id, ...MetricFields })).output(type<Metric>()),
    archive: oc.input(input({ ...Id, archived: Schema.Boolean })).output(type<Metric>()),
  },

  dataSources: {
    list: oc.output(type<ReadonlyArray<DataSource>>()),
    get: oc.input(input(Id)).output(type<DataSource>()),
    createBigQuery: oc
      .input(
        input({
          name: Schema.String,
          bigquery: BigQueryConfig,
          credentialsJson: Schema.String,
          exposureSql: Schema.String,
        }),
      )
      .output(type<DataSource>()),
    /** credentialsJson null keeps the stored credentials */
    update: oc
      .input(
        input({
          ...Id,
          name: Schema.String,
          bigquery: Schema.NullOr(BigQueryConfig),
          credentialsJson: Schema.NullOr(Schema.String),
          exposureSql: Schema.String,
        }),
      )
      .output(type<DataSource>()),
    /** The builtin source and sources used by metrics cannot be deleted (CONFLICT) */
    delete: oc.input(input(Id)).output(type<void>()),
    /** Authenticates and dry-runs the exposure SQL */
    test: oc.input(input(Id)).output(type<ConnectionTestResult>()),
  },

  results: {
    /** Latest stored snapshot for the current phase, null if never analyzed */
    latest: oc.input(input({ experimentId: Schema.String })).output(type<ResultSnapshot | null>()),
    /** Runs the analysis now and stores a snapshot (analysis errors are stored in it, not thrown) */
    refresh: oc.input(input({ experimentId: Schema.String })).output(type<ResultSnapshot>()),
  },

  events: {
    /** Distinct event names in the built-in store over the last 30 days, most frequent first */
    names: oc.input(input({ environmentId: Schema.String })).output(type<ReadonlyArray<EventNameStat>>()),
    /** Hourly ingestion volume for the last 24 hours */
    volume: oc.input(input({ environmentId: Schema.String })).output(type<ReadonlyArray<VolumeBucket>>()),
  },

  audit: {
    list: oc
      .input(
        input({
          entityType: Schema.NullOr(AuditEntityType),
          entityId: Schema.NullOr(Schema.String),
          /** Cursor: entries strictly older than this */
          before: Schema.NullOr(Schema.Date),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
        }),
      )
      .output(type<ReadonlyArray<AuditLog>>()),
  },

  members: {
    list: oc.output(type<{ members: ReadonlyArray<Member>; invitations: ReadonlyArray<Invitation> }>()),
    /** Creates a 7-day one-time sign-up link (no email is sent; share the URL) */
    invite: oc.input(input({ email: Schema.String })).output(type<Invitation>()),
    revokeInvitation: oc.input(input(Id)).output(type<void>()),
    /** Owner only; the owner cannot remove themselves */
    remove: oc.input(input(Id)).output(type<void>()),
  },
};

export type KujiContract = typeof contract;
