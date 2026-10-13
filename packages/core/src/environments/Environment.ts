import { Schema } from "effect";

/** Delivery environment. Each has its own SDK key and per-flag on/off + rules */
export class Environment extends Schema.Class<Environment>("Environment")({
  id: Schema.String,
  /** Identifier used in URLs and code (production, development, ...) */
  key: Schema.String,
  name: Schema.String,
  /** Public key the SDK uses to fetch the payload and send events */
  sdkKey: Schema.String,
  sortOrder: Schema.Int,
  createdAt: Schema.Date,
}) {}
