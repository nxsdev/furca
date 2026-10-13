import { publicRouter } from "../Handlers/public";
import { sessionRouter } from "../Handlers/session";
import { environmentsRouter } from "../Handlers/environments";
import { featuresRouter } from "../Handlers/features";
import { experimentsRouter } from "../Handlers/experiments";
import { metricsRouter } from "../Handlers/metrics";
import { dataSourcesRouter } from "../Handlers/dataSources";
import { resultsRouter } from "../Handlers/results";
import { eventsRouter } from "../Handlers/events";
import { auditRouter } from "../Handlers/audit";
import { membersRouter } from "../Handlers/members";
import { pub } from "./orpc";

/** The whole admin API. Each domain router lives in ../Handlers/<domain>.ts */
export const router = pub.router({
  public: publicRouter,
  session: sessionRouter,
  environments: environmentsRouter,
  features: featuresRouter,
  experiments: experimentsRouter,
  metrics: metricsRouter,
  dataSources: dataSourcesRouter,
  results: resultsRouter,
  events: eventsRouter,
  audit: auditRouter,
  members: membersRouter,
});
