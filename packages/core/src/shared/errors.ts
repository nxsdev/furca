import { Schema } from "effect";
import { errorMessages } from "./errorMessages";

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Stable id of a user-facing error (`flag.keyTaken`), translated by the admin UI */
export type ErrorCode = Leaves<typeof errorMessages>;

export type ErrorParams = Readonly<Record<string, string | number>>;

const leaves = (node: object, prefix = ""): Array<string> =>
  Object.entries(node).flatMap(([k, v]) => (typeof v === "string" ? [prefix + k] : leaves(v as object, `${prefix}${k}.`)));

/** Every code, for tests that check each one is translated */
export const errorCodes = leaves(errorMessages) as ReadonlyArray<ErrorCode>;

/** English text of a code with its params filled in; a `reason` param is itself a code */
export const errorText = (code: ErrorCode, params: ErrorParams = {}): string => {
  const template = code.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], errorMessages);
  return String(template).replace(/{{(\w+)}}/g, (_, name: string) =>
    name === "reason" ? errorText(params.reason as ErrorCode, params) : String(params[name] ?? ""),
  );
};

/**
 * A user-facing error: the English `message` plus what the UI needs to translate it (`code`,
 * `params`) and the form field it belongs to (`field`). Pass it to ValidationError / ConflictError /
 * ForbiddenError / WarehouseError
 */
export interface Issue {
  readonly message: string;
  readonly code: ErrorCode;
  readonly params?: ErrorParams | undefined;
  readonly field?: string | undefined;
}

export const issue = (code: ErrorCode, params?: ErrorParams, field?: string): Issue => ({
  message: errorText(code, params),
  code,
  params,
  field,
});

/** Optional on every message-bearing error: errors raised without a code show their message as is */
const detail = {
  code: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite]))),
  field: Schema.optional(Schema.String),
};

/** Entities NotFoundError names; each has a `notFound.<entity>` code */
export const NotFoundEntity = Schema.Literals([
  "feature",
  "environment",
  "experiment",
  "metric",
  "dataSource",
  "savedGroup",
  "namespace",
  "member",
  "invitation",
  "apiKey",
  "webhook",
  "changeRequest",
]);

/** The target entity does not exist */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: NotFoundEntity,
  id: Schema.String,
}) {}

/** Input violating a business rule (duplicate key, invalid state transition, ...) */
export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
  ...detail,
}) {}

/** Database access failed */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  operation: Schema.String,
  cause: Schema.Unknown,
}) {}

/** Warehouse (BigQuery, ...) query failed. message must be safe to show to users */
export class WarehouseError extends Schema.TaggedError<WarehouseError>()("WarehouseError", {
  message: Schema.String,
  ...detail,
}) {}

/** The change conflicts with existing data (entity still in use, last of its kind). message is safe to show */
export class ConflictError extends Schema.TaggedError<ConflictError>()("ConflictError", {
  message: Schema.String,
  ...detail,
}) {}

/** The caller may not do this (role, own review, protected environment). message is safe to show */
export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()("ForbiddenError", {
  message: Schema.String,
  ...detail,
}) {}
