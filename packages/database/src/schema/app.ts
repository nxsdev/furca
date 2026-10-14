import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull();
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).default(nowMs).notNull();
/** JSON column. Shapes are validated with the core Schema at the repository boundary */
const json = (name: string) => text(name, { mode: "json" }).$type<unknown>().notNull();

/** Delivery environments (production / development are seeded) */
export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  sdkKey: text("sdk_key").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Flag on/off and rule changes go through change_requests */
  requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

/** Feature flag aggregate root */
export const features = sqliteTable("features", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  description: text("description").notNull().default(""),
  valueType: text("value_type").notNull(),
  /** JSON-encoded value */
  defaultValue: text("default_value").notNull(),
  tags: json("tags"),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Per-environment flag state; child of the feature aggregate */
export const featureEnvironments = sqliteTable(
  "feature_environments",
  {
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** Ordered FeatureRule[] */
    rules: json("rules"),
  },
  (t) => [primaryKey({ columns: [t.featureId, t.environmentId] })],
);

/** Experiment aggregate root. Phases / variations / settings are JSON children */
export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    hypothesis: text("hypothesis").notNull().default(""),
    status: text("status").notNull(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id),
    environmentIds: json("environment_ids"),
    analysisEnvironmentId: text("analysis_environment_id").notNull(),
    hashAttribute: text("hash_attribute").notNull(),
    variations: json("variations"),
    phases: json("phases"),
    coverage: real("coverage").notNull(),
    weights: json("weights"),
    conditions: json("conditions"),
    dataSourceId: text("data_source_id").notNull(),
    primaryMetricId: text("primary_metric_id"),
    secondaryMetricIds: json("secondary_metric_ids"),
    guardrailMetricIds: json("guardrail_metric_ids"),
    stats: json("stats"),
    plan: json("plan"),
    decision: text("decision", { mode: "json" }).$type<unknown>(),
    /** Attribute names recorded with exposures for breakdowns */
    dimensions: text("dimensions", { mode: "json" }).$type<unknown>().notNull().default(sql`'[]'`),
    /** NamespaceAllocation JSON or null */
    namespace: text("namespace", { mode: "json" }).$type<unknown>(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    stoppedAt: integer("stopped_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("experiments_feature_idx").on(t.featureId)],
);

export const metrics = sqliteTable("metrics", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  type: text("type").notNull(),
  dataSourceId: text("data_source_id").notNull(),
  definition: json("definition"),
  inverse: integer("inverse", { mode: "boolean" }).notNull().default(false),
  windowHours: real("window_hours"),
  delayHours: real("delay_hours").notNull().default(0),
  capping: json("capping"),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const dataSources = sqliteTable("data_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  /** BigQueryConfig JSON, null for builtin */
  config: text("config", { mode: "json" }).$type<unknown>(),
  /** AES-GCM encrypted service account JSON (base64 iv + ciphertext) */
  credentials: text("credentials"),
  exposureSql: text("exposure_sql").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Built-in exposure log: one row per (unit, experiment, phase, variation) keeping the first time seen
 * in that phase. A unit with rows for 2+ variations in one phase is a multiple exposure and is
 * excluded from that phase's analysis
 */
export const exposures = sqliteTable(
  "exposures",
  {
    environmentId: text("environment_id").notNull(),
    experimentKey: text("experiment_key").notNull(),
    variationKey: text("variation_key").notNull(),
    userId: text("user_id").notNull(),
    /** epoch ms */
    firstSeenAt: integer("first_seen_at").notNull(),
    /** Experiment phase index the SDK evaluated (a new phase re-randomizes) */
    phase: integer("phase").notNull().default(0),
    /** Values of the experiment's dimension attributes at first exposure, JSON object */
    dimensions: text("dimensions", { mode: "json" }).$type<unknown>(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.experimentKey, t.phase, t.userId, t.variationKey] }),
    index("exposures_time_idx").on(t.environmentId, t.firstSeenAt),
  ],
);

/** Built-in event store, fed by the SDK's track() */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    environmentId: text("environment_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    value: real("value"),
    /** epoch ms */
    ts: integer("ts").notNull(),
    /** Flat properties passed to track(name, value, properties), JSON object */
    properties: text("properties", { mode: "json" }).$type<unknown>(),
  },
  (t) => [
    index("events_name_user_ts_idx").on(t.environmentId, t.name, t.userId, t.ts),
    index("events_ts_idx").on(t.environmentId, t.ts),
  ],
);

export const resultSnapshots = sqliteTable(
  "result_snapshots",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    phaseIndex: integer("phase_index").notNull(),
    computedAt: integer("computed_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status").notNull(),
    error: text("error"),
    health: text("health", { mode: "json" }).$type<unknown>(),
    metrics: json("metrics"),
  },
  (t) => [index("result_snapshots_experiment_idx").on(t.experimentId, t.computedAt)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    before: text("before"),
    after: text("after"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    token: text("token").notNull(),
    invitedBy: text("invited_by").notNull(),
    /** admin | editor | viewer, given to the account created through this invitation */
    role: text("role").notNull().default("viewer"),
    createdAt: createdAt(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("invitations_token_idx").on(t.token)],
);

/** Reusable audiences referenced by in_group / not_in_group conditions */
export const savedGroups = sqliteTable("saved_groups", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  type: text("type").notNull(),
  conditions: json("conditions"),
  attribute: text("attribute").notNull().default(""),
  values: json("values"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Mutual-exclusion namespaces; allocations live on experiments.namespace */
export const namespaces = sqliteTable("namespaces", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** REST API keys. Only the SHA-256 of the secret is stored */
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  secretHash: text("secret_hash").notNull().unique(),
  role: text("role").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  format: text("format").notNull(),
  events: json("events"),
  /** HMAC signing secret, encrypted with CredentialCipher */
  secret: text("secret").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastDeliveredAt: integer("last_delivered_at", { mode: "timestamp_ms" }),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
});

/** Reviewed flag changes for environments that require approval */
export const changeRequests = sqliteTable(
  "change_requests",
  {
    id: text("id").primaryKey(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** FlagChange JSON: { type: "toggle", enabled } | { type: "rules", rules } */
    change: json("change"),
    /** FlagState JSON ({ enabled, rules }) when the request was opened */
    base: json("base"),
    comment: text("comment").notNull().default(""),
    /** open | approved | rejected | cancelled */
    status: text("status").notNull(),
    authorId: text("author_id").notNull(),
    authorEmail: text("author_email").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerEmail: text("reviewer_email"),
    reviewComment: text("review_comment").notNull().default(""),
    createdAt: createdAt(),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("change_requests_status_idx").on(t.status, t.createdAt), index("change_requests_feature_idx").on(t.featureId)],
);
