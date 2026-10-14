import { ApiKeyServiceLive } from "@furca/persistence/Layers/ApiKeyServiceLive";
import { AuditServiceLive } from "@furca/persistence/Layers/AuditServiceLive";
import { ChangeRequestServiceLive } from "@furca/persistence/Layers/ChangeRequestServiceLive";
import { DataSourceServiceLive } from "@furca/persistence/Layers/DataSourceServiceLive";
import { EnvironmentServiceLive } from "@furca/persistence/Layers/EnvironmentServiceLive";
import { ExperimentServiceLive } from "@furca/persistence/Layers/ExperimentServiceLive";
import { FeatureServiceLive } from "@furca/persistence/Layers/FeatureServiceLive";
import { MemberServiceLive } from "@furca/persistence/Layers/MemberServiceLive";
import { MetricServiceLive } from "@furca/persistence/Layers/MetricServiceLive";
import { NamespaceServiceLive } from "@furca/persistence/Layers/NamespaceServiceLive";
import { SavedGroupServiceLive } from "@furca/persistence/Layers/SavedGroupServiceLive";
import { SdkServiceLive } from "@furca/persistence/Layers/SdkServiceLive";
import { WebhookDispatcherLive, WebhookServiceLive } from "@furca/persistence/Layers/WebhookServiceLive";
import { Layer } from "effect";

/**
 * Domain services for flags, experiments, metrics, data sources, environments, audit and members.
 * Owned by the backend implementation; must only require BaseServices
 */
export const CoreServicesLive = Layer.mergeAll(
  AuditServiceLive,
  ChangeRequestServiceLive,
  DataSourceServiceLive,
  EnvironmentServiceLive,
  ExperimentServiceLive,
  FeatureServiceLive,
  MemberServiceLive,
  MetricServiceLive,
  NamespaceServiceLive,
  SavedGroupServiceLive,
  SdkServiceLive,
  ApiKeyServiceLive,
  WebhookServiceLive,
  // Feature / experiment / environment services emit through it (persistence/src/webhooks.ts)
  WebhookDispatcherLive,
);
