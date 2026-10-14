import { Context, type Effect } from "effect";

/** Work that must not delay the response (webhook deliveries, lastUsedAt touches) */
export interface BackgroundTasksShape {
  /**
   * Starts `task` and returns at once on Workers (ctx.waitUntil). Without an ExecutionContext
   * (tests, cron) it runs inline. The task must handle its own failures
   */
  readonly run: (task: Effect.Effect<void>) => Effect.Effect<void>;
}

export class BackgroundTasks extends Context.Service<BackgroundTasks, BackgroundTasksShape>()("furca/BackgroundTasks") {}
