import { Layer } from "effect";
import { AnalysisServicesLive } from "./AnalysisServices";
import { makeBaseLayer } from "./BaseServices";
import { CoreServicesLive } from "./CoreServices";
import type { KujiEnv } from "./Env";

/** Every Effect service available to oRPC handlers and SDK endpoints, built per request */
export const makeAppLayer = (env: KujiEnv) =>
  Layer.mergeAll(CoreServicesLive, AnalysisServicesLive).pipe(Layer.provideMerge(makeBaseLayer(env)));

export type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>;
