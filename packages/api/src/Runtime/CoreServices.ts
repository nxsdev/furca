import { Layer } from "effect";

/**
 * Domain services for flags, experiments, metrics, data sources, environments, audit and members.
 * Owned by the backend implementation; must only require BaseServices
 */
export const CoreServicesLive = Layer.empty;
