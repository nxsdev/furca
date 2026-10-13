import { Invitation, Member } from "@furca/core/members/Member";
import { MemberService } from "@furca/core/members/MemberService";
import { NotFoundError } from "@furca/core/shared/errors";
import { Database } from "@furca/database/Database";
import { account, invitations, session, user } from "@furca/database/schema/index";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { auditInsert, batch, invalid, newId, randomHex } from "../shared";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const toInvitation = (row: typeof invitations.$inferSelect) =>
  Invitation.make({ id: row.id, email: row.email, url: `/invite/${row.token}`, createdAt: row.createdAt, expiresAt: row.expiresAt });

export const MemberServiceLive = Layer.effect(
  MemberService,
  Effect.gen(function* () {
    const database = yield* Database;

    return {
      list: Effect.gen(function* () {
        const users = yield* database.run("members.list", (db) => db.query.user.findMany({ orderBy: { createdAt: "asc", id: "asc" } }));
        const pending = yield* database.run("invitations.pending", (db) =>
          db.query.invitations.findMany({
            where: { acceptedAt: { isNull: true }, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" },
          }),
        );
        return {
          members: users.map((u, i) =>
            Member.make({ id: u.id, email: u.email, name: u.name, isOwner: i === 0, createdAt: u.createdAt }),
          ),
          invitations: pending.map(toInvitation),
        };
      }).pipe(Effect.withSpan("MemberService.list")),

      invite: Effect.fn("MemberService.invite")(function* (rawEmail, actor) {
        const email = rawEmail.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) return yield* invalid("Enter a valid email address");
        const existing = yield* database.run("members.byEmail", (db) =>
          db.query.user.findFirst({ where: { RAW: (u) => sql`lower(${u.email}) = ${email}` } }),
        );
        if (existing !== undefined) return yield* invalid(`${email} is already a member`);
        const now = new Date();
        const row = {
          id: newId(),
          email,
          token: randomHex(32),
          invitedBy: actor.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
          acceptedAt: null,
        };
        const invitation = toInvitation(row);
        yield* database.run("invitations.create", (db) =>
          batch(db, [
            // Re-inviting replaces the pending link
            db.delete(invitations).where(and(eq(invitations.email, email), isNull(invitations.acceptedAt))),
            db.insert(invitations).values(row),
            auditInsert(db, { entityType: "member", entityId: invitation.id, action: "invited", actor, before: null, after: invitation }),
          ]),
        );
        return invitation;
      }),

      revokeInvitation: Effect.fn("MemberService.revokeInvitation")(function* (id, actor) {
        const row = yield* database.run("invitations.get", (db) =>
          db.query.invitations.findFirst({ where: { id, acceptedAt: { isNull: true } } }),
        );
        if (row === undefined) return yield* new NotFoundError({ entity: "invitation", id });
        yield* database.run("invitations.revoke", (db) =>
          batch(db, [
            db.delete(invitations).where(eq(invitations.id, id)),
            auditInsert(db, { entityType: "member", entityId: id, action: "invitation.revoked", actor, before: toInvitation(row), after: null }),
          ]),
        );
      }),

      remove: Effect.fn("MemberService.remove")(function* (id, actor) {
        const users = yield* database.run("members.list", (db) => db.query.user.findMany({ orderBy: { createdAt: "asc", id: "asc" } }));
        const index = users.findIndex((u) => u.id === id);
        const row = users[index];
        if (row === undefined) return yield* new NotFoundError({ entity: "member", id });
        const before = Member.make({ id: row.id, email: row.email, name: row.name, isOwner: index === 0, createdAt: row.createdAt });
        yield* database.run("members.remove", (db) =>
          batch(db, [
            db.delete(session).where(eq(session.userId, id)),
            db.delete(account).where(eq(account.userId, id)),
            db.delete(user).where(eq(user.id, id)),
            auditInsert(db, { entityType: "member", entityId: id, action: "removed", actor, before, after: null }),
          ]),
        );
      }),
    };
  }),
);
