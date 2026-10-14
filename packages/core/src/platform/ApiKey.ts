import { Schema } from "effect";

/** admin: every API call a member could make; readonly: list / get style calls only */
export const ApiKeyRole = Schema.Literals(["admin", "readonly"]);
export type ApiKeyRole = typeof ApiKeyRole.Type;

/** Secret key for the REST API (`Authorization: Bearer furca_…`). Only a hash is stored */
export class ApiKey extends Schema.Class<ApiKey>("ApiKey")({
  id: Schema.String,
  name: Schema.String,
  /** First characters of the secret, to recognize a key without revealing it */
  prefix: Schema.String,
  role: ApiKeyRole,
  createdBy: Schema.String,
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date),
}) {}
