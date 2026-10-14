import { Layer } from "effect";
import { AnalysisServicesLive } from "./AnalysisServices";
import { makeBaseLayer } from "./BaseServices";
import { CoreServicesLive } from "./CoreServices";
import type { FurcaEnv } from "./Env";

/** Every Effect service available to oRPC handlers and SDK endpoints, built per request */
export const makeAppLayer = (env: FurcaEnv, ctx?: ExecutionContext) =>
  Layer.mergeAll(CoreServicesLive, AnalysisServicesLive).pipe(Layer.provideMerge(makeBaseLayer(env, ctx)));

export type AppServices = Layer.Success<ReturnType<typeof makeAppLayer>>;
