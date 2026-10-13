import { ExperimentAnalysisService } from "@furca/core/analysis/Analysis";
import { Database } from "@furca/database/Database";
import { Effect, Layer } from "effect";
import { AnalysisServicesLive } from "./AnalysisServices";
import { makeBaseLayer } from "./BaseServices";
import type { FurcaEnv } from "./Env";

/** Refreshes every running experiment one by one; a failing experiment is logged and skipped */
const refreshRunningExperiments = Effect.gen(function* () {
  const database = yield* Database;
  const analysis = yield* ExperimentAnalysisService;
  const running = yield* database.run("experiments.running", (db) =>
    db.query.experiments.findMany({ where: { status: "running", archivedAt: { isNull: true } }, columns: { id: true, key: true } }),
  );
  // ponytail: sequential and in one cron invocation; fan out to a Queue if refreshes outgrow the 15 min cron limit
  for (const experiment of running) {
    yield* analysis
      .refresh(experiment.id)
      .pipe(Effect.catchCause((cause) => Effect.logError(`Scheduled analysis of experiment "${experiment.key}" failed`, cause)));
  }
});

/** Hourly cron: refresh results of running experiments */
export const runScheduledAnalysis = (env: FurcaEnv): Promise<void> =>
  Effect.runPromise(refreshRunningExperiments.pipe(Effect.provide(AnalysisServicesLive.pipe(Layer.provideMerge(makeBaseLayer(env))))));
