import { Schema } from "effect";

/**
 * Mutual exclusion: experiments in the same namespace take non-overlapping slices of [0, 1),
 * so a user is in at most one of them. Hashing is GrowthBook-compatible
 */
export class Namespace extends Schema.Class<Namespace>("Namespace")({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  description: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}

/** The slice [start, end) of a namespace an experiment occupies */
export class NamespaceAllocation extends Schema.Class<NamespaceAllocation>("NamespaceAllocation")({
  namespaceId: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
}) {}
