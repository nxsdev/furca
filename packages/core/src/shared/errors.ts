import { Schema } from "effect";

/** The target entity does not exist */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: Schema.String,
  id: Schema.String,
}) {}

/** Input violating a business rule (duplicate key, invalid state transition, ...) */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

/** Database access failed */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/** Warehouse (BigQuery, ...) query failed. message must be safe to show to users */
export class WarehouseError extends Schema.TaggedError<WarehouseError>()("WarehouseError", {
  message: Schema.String,
}) {}
