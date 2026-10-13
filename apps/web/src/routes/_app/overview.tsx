import { buttonVariants, Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AuditList } from "~/components/audit/AuditList";
import { apiHost, CodeBlock, INSTALL } from "~/components/environments/Quickstart";
import { Onboarding, type OnboardingStep } from "~/components/overview/Onboarding";
import { RunningExperiments } from "~/components/overview/RunningExperiments";
import { TrafficChart } from "~/components/overview/TrafficChart";
import { PageHeader, Panel, PanelHeader, QueryError } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/overview")({
  head: () => ({ meta: [{ title: "Overview · furca" }] }),
  component: Page,
});

const linkCls = "rounded-sm text-label text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus";

const firstSnippet = (sdkKey: string, flagKey: string) => `import { createClient } from "@furca/sdk";

const furca = createClient({
  apiHost: "${apiHost()}",
  sdkKey: "${sdkKey}",
  attributes: { id: user.id },
});
await furca.ready();

if (furca.isOn("${flagKey}")) {
  // the new code path
}`;

function Page() {
  const { current } = useEnvironment();
  const envInput = { input: { environmentId: current?.id ?? "" } };
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const names = useQuery({ ...orpc.events.names.queryOptions(envInput), enabled: current !== null });
  const volume = useQuery({ ...orpc.events.volume.queryOptions(envInput), enabled: current !== null });

  const header = (
    <PageHeader
      title="Overview"
      description={`Running experiments, recent changes and SDK traffic${current === null ? "" : ` in ${current.name}`}.`}
    />
  );
  const core = [features, experiments, metrics] as const;
  if (core.some((q) => q.isPending))
    return (
      <>
        {header}
        <div className="flex flex-col gap-6" aria-busy="true">
          <Skeleton className="h-40 rounded-[10px]" />
          <Skeleton className="h-64 rounded-[10px]" />
        </div>
      </>
    );
  const failed = core.find((q) => q.isError);
  if (failed !== undefined || features.data === undefined || experiments.data === undefined || metrics.data === undefined)
    return (
      <>
        {header}
        <QueryError
          message={`Couldn't load the overview. ${errorMessage(failed?.error)}`}
          onRetry={() => core.forEach((q) => void q.refetch())}
        />
      </>
    );

  const eventNames = names.data ?? [];
  const sawTraffic = eventNames.length > 0 || (volume.data ?? []).some((b) => b.events + b.exposures > 0);
  const flagKey = features.data[0]?.key ?? "my-first-flag";
  const steps: ReadonlyArray<OnboardingStep> = [
    {
      id: "flag",
      title: "Create a flag",
      description: features.data.length > 0
        ? `${features.data.length} ${features.data.length === 1 ? "flag" : "flags"} so far.`
        : "A flag wraps the code you want to change. Start with an on/off flag around one new behavior.",
      done: features.data.length > 0,
      action: (v) => (
        <Link to="/flags" search={{ new: "1" }} className={buttonVariants({ size: "sm", variant: v })}>
          Create flag
        </Link>
      ),
    },
    {
      id: "sdk",
      title: "Install the SDK",
      description: sawTraffic
        ? `${current?.name ?? "This environment"} is receiving SDK traffic.`
        : `Add @furca/sdk to your app with the ${current?.name ?? ""} key. It downloads one payload and evaluates flags locally, with no request per check.`,
      done: sawTraffic,
      body:
        current === null ? undefined : (
          <div className="flex w-full max-w-[720px] flex-col gap-2">
            <CodeBlock code={INSTALL} label="Copy install command" />
            <CodeBlock code={firstSnippet(current.sdkKey, flagKey)} />
            <Link to="/environments" className={`${linkCls} w-fit`}>
              Cloudflare Workers, Node and other environments
            </Link>
          </div>
        ),
    },
    {
      id: "metric",
      title: "Send events and define a metric",
      description:
        metrics.data.length > 0 ? (
          `${metrics.data.length} ${metrics.data.length === 1 ? "metric" : "metrics"} defined.`
        ) : (
          <>
            Call <code className="font-mono text-foreground">furca.track("purchase")</code> where the outcome happens, then turn
            that event into a metric like "share of users who purchased".
            {eventNames.length > 0 &&
              ` Received so far: ${eventNames
                .slice(0, 3)
                .map((n) => n.name)
                .join(", ")}${eventNames.length > 3 ? "…" : ""}.`}
          </>
        ),
      done: metrics.data.length > 0,
      action: (v) => (
        <Link to="/metrics" search={{ new: true }} className={buttonVariants({ size: "sm", variant: v })}>
          Define a metric
        </Link>
      ),
    },
    {
      id: "experiment",
      title: "Start an experiment",
      description:
        "Pick the flag, a primary metric and the traffic split. furca assigns users deterministically and tells you when the result is real.",
      done: experiments.data.some((x) => x.status !== "draft"),
      action: (v) => (
        <Link to="/experiments/new" className={buttonVariants({ size: "sm", variant: v })}>
          Create experiment
        </Link>
      ),
    },
  ];
  const allDone = steps.every((s) => s.done);
  const nothingYet = features.data.length === 0 && experiments.data.length === 0;

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {!allDone && <Onboarding steps={steps} />}
        {!nothingYet && (
          <>
            <RunningExperiments experiments={experiments.data} />
            {current !== null && (
              <Panel>
                <PanelHeader
                  title="SDK traffic"
                  description={`Exposures and tracked events per hour in ${current.name}, last 24 hours.`}
                  actions={
                    <Link to="/data-sources/$dataSourceId" params={{ dataSourceId: "builtin" }} className={`${linkCls} shrink-0`}>
                      Event store
                    </Link>
                  }
                />
                <TrafficChart environmentId={current.id} environmentName={current.name} />
              </Panel>
            )}
            <Panel>
              <PanelHeader
                title="Recent changes"
                actions={
                  <Link to="/audit" className={`${linkCls} shrink-0`}>
                    Audit log
                  </Link>
                }
              />
              <AuditList limit={8} paginate={false} />
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
