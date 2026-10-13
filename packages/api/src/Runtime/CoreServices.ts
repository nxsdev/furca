import { AuditServiceLive } from "@furca/persistence/Layers/AuditServiceLive";
import { DataSourceServiceLive } from "@furca/persistence/Layers/DataSourceServiceLive";
import { EnvironmentServiceLive } from "@furca/persistence/Layers/EnvironmentServiceLive";
import { ExperimentServiceLive } from "@furca/persistence/Layers/ExperimentServiceLive";
import { FeatureServiceLive } from "@furca/persistence/Layers/FeatureServiceLive";
import { MemberServiceLive } from "@furca/persistence/Layers/MemberServiceLive";
import { MetricServiceLive } from "@furca/persistence/Layers/MetricServiceLive";
import { SdkServiceLive } from "@furca/persistence/Layers/SdkServiceLive";
import { Layer } from "effect";

/**
 * Domain services for flags, experiments, metrics, data sources, environments, audit and members.
 * Owned by the backend implementation; must only require BaseServices
 */
export const CoreServicesLive = Layer.mergeAll(
  AuditServiceLive,
  DataSourceServiceLive,
  EnvironmentServiceLive,
  ExperimentServiceLive,
  FeatureServiceLive,
  MemberServiceLive,
  MetricServiceLive,
  SdkServiceLive,
);
