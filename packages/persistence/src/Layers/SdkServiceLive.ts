import { PayloadStore } from "@kuji/core/environments/PayloadStore";
import { SdkService } from "@kuji/core/environments/SdkService";
import { NotFoundError } from "@kuji/core/shared/errors";
import { Database } from "@kuji/database/Database";
import { events, exposures } from "@kuji/database/schema/index";
import { Effect, Layer } from "effect";
import { buildPayloads } from "../payload";
import { batch, chunk } from "../shared";

const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * HOUR_MS;

export const SdkServiceLive = Layer.effect(
  SdkService,
  Effect.gen(function* () {
    const database = yield* Database;
    const store = yield* PayloadStore;

    const environmentBySdkKey = (sdkKey: string) =>
      database
        .run("environments.bySdkKey", (db) => db.query.environments.findFirst({ where: { sdkKey } }))
        .pipe(Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new NotFoundError({ entity: "environment", id: sdkKey })))));

    return {
      payload: Effect.fn("SdkService.payload")(function* (sdkKey) {
        const stored = yield* store.get(sdkKey);
        if (stored !== null) return stored;
        const environment = yield* environmentBySdkKey(sdkKey);
        const [built] = yield* buildPayloads(database, environment.id);
        const json = JSON.stringify(built?.payload ?? null);
        yield* store.put(sdkKey, json);
        return json;
      }),

      ingest: Effect.fn("SdkService.ingest")(function* (sdkKey, input) {
        const environment = yield* environmentBySdkKey(sdkKey);
        const now = Date.now();
        const keep = (item: { readonly userId: string; readonly ts: number }) =>
          item.userId !== "" && item.ts <= now + HOUR_MS && item.ts >= now - MAX_AGE_MS;
        const exposureRows = input.exposures.filter(keep).map((e) => ({
          environmentId: environment.id,
          experimentKey: e.experimentKey,
          variationKey: e.variationKey,
          phase: e.phase,
          userId: e.userId,
          firstSeenAt: Math.round(e.ts),
        }));
        const eventRows = input.events.filter(keep).map((e) => ({
          environmentId: environment.id,
          userId: e.userId,
          name: e.name,
          value: e.value,
          ts: Math.round(e.ts),
        }));
        yield* database.run("sdk.ingest", (db) =>
          batch(db, [
            // The primary key keeps the first time a unit saw a variation in a phase
            ...chunk(exposureRows, 6).map((rows) => db.insert(exposures).values([...rows]).onConflictDoNothing()),
            ...chunk(eventRows, 6).map((rows) => db.insert(events).values([...rows])),
          ]),
        );
        return exposureRows.length + eventRows.length;
      }),
    };
  }),
);
