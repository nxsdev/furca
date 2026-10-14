import { Schema } from "effect";
import { Condition } from "./Condition";

export const SavedGroupType = Schema.Literals(["condition", "list"]);
export type SavedGroupType = typeof SavedGroupType.Type;

/**
 * Reusable audience referenced from targeting with the in_group / not_in_group operators.
 * condition: users matching all `conditions`; list: users whose `attribute` is one of `values`
 */
export class SavedGroup extends Schema.Class<SavedGroup>("SavedGroup")({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  description: Schema.String,
  type: SavedGroupType,
  /** type = condition */
  conditions: Schema.Array(Condition),
  /** type = list */
  attribute: Schema.String,
  /** type = list. Shipped in every SDK payload, so keep lists small (max 10,000) */
  values: Schema.Array(Schema.String),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
}) {}
