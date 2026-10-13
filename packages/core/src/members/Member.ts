import { Schema } from "effect";

export class Member extends Schema.Class<Member>("Member")({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  /** The first user. Only the owner can remove members */
  isOwner: Schema.Boolean,
  createdAt: Schema.Date,
}) {}

export class Invitation extends Schema.Class<Invitation>("Invitation")({
  id: Schema.String,
  email: Schema.String,
  /** Sign-up URL path containing the one-time token */
  url: Schema.String,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
}) {}
