import { AuditServiceLive } from "@kuji/persistence/Layers/AuditServiceLive";
import { DataSourceServiceLive } from "@kuji/persistence/Layers/DataSourceServiceLive";
import { EnvironmentServiceLive } from "@kuji/persistence/Layers/EnvironmentServiceLive";
import { ExperimentServiceLive } from "@kuji/persistence/Layers/ExperimentServiceLive";
import { FeatureServiceLive } from "@kuji/persistence/Layers/FeatureServiceLive";
import { MemberServiceLive } from "@kuji/persistence/Layers/MemberServiceLive";
import { MetricServiceLive } from "@kuji/persistence/Layers/MetricServiceLive";
import { SdkServiceLive } from "@kuji/persistence/Layers/SdkServiceLive";
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
