import { buttonVariants, Skeleton } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { AuditList } from "~/components/audit/AuditList";
import { apiHost, CodeBlock, INSTALL } from "~/components/environments/Quickstart";
import { Onboarding, type OnboardingStep } from "~/components/overview/Onboarding";
import { RunningExperiments } from "~/components/overview/RunningExperiments";
import { TrafficChart } from "~/components/overview/TrafficChart";
import { PageHeader, Panel, PanelHeader, QueryError } from "~/components/ui/primitives";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

export const Route = createFileRoute("/_app/overview")({
  head: () => ({ meta: [{ title: i18n.t("overview:pageTitle") }] }),
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
  const { t } = useTranslation("overview");
  const { current } = useEnvironment();
  const envInput = { input: { environmentId: current?.id ?? "" } };
  const features = useQuery(orpc.features.list.queryOptions({ input: { includeArchived: false } }));
  const experiments = useQuery(orpc.experiments.list.queryOptions({ input: { includeArchived: false } }));
  const metrics = useQuery(orpc.metrics.list.queryOptions({ input: { includeArchived: false } }));
  const names = useQuery({ ...orpc.events.names.queryOptions(envInput), enabled: current !== null });
  const volume = useQuery({ ...orpc.events.volume.queryOptions(envInput), enabled: current !== null });

  const header = (
    <PageHeader
      title={t("page.title")}
      description={current === null ? t("page.description") : t("page.descriptionIn", { name: current.name })}
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
          message={t("page.loadFailed", { message: errorMessage(failed?.error) })}
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
      title: t("steps.flag.title"),
      description:
        features.data.length > 0 ? t("steps.flag.doneDescription", { count: features.data.length }) : t("steps.flag.description"),
      done: features.data.length > 0,
      action: (v) => (
        <Link to="/flags" search={{ new: "1" }} className={buttonVariants({ size: "sm", variant: v })}>
          {t("steps.flag.action")}
        </Link>
      ),
    },
    {
      id: "sdk",
      title: t("steps.sdk.title"),
      // ponytail: sawTraffic implies a selected environment (its queries are disabled otherwise)
      description: t(sawTraffic ? "steps.sdk.doneDescription" : "steps.sdk.description", { name: current?.name ?? "" }),
      done: sawTraffic,
      body:
        current === null ? undefined : (
          <div className="flex w-full max-w-[720px] flex-col gap-2">
            <CodeBlock code={INSTALL} label={t("steps.sdk.copyInstall")} />
            <CodeBlock code={firstSnippet(current.sdkKey, flagKey)} />
            <Link to="/environments" className={`${linkCls} w-fit`}>
              {t("steps.sdk.otherRuntimes")}
            </Link>
          </div>
        ),
    },
    {
      id: "metric",
      title: t("steps.metric.title"),
      description:
        metrics.data.length > 0 ? (
          t("steps.metric.doneDescription", { count: metrics.data.length })
        ) : (
          <Trans
            t={t}
            i18nKey={eventNames.length > 0 ? "steps.metric.descriptionWithEvents" : "steps.metric.description"}
            values={{
              call: 'furca.track("purchase")',
              names: `${eventNames
                .slice(0, 3)
                .map((n) => n.name)
                .join(", ")}${eventNames.length > 3 ? "…" : ""}`,
            }}
            components={{ code: <code className="font-mono text-foreground" /> }}
          />
        ),
      done: metrics.data.length > 0,
      action: (v) => (
        <Link to="/metrics" search={{ new: true }} className={buttonVariants({ size: "sm", variant: v })}>
          {t("steps.metric.action")}
        </Link>
      ),
    },
    {
      id: "experiment",
      title: t("steps.experiment.title"),
      description: t("steps.experiment.description"),
      done: experiments.data.some((x) => x.status !== "draft"),
      action: (v) => (
        <Link to="/experiments/new" className={buttonVariants({ size: "sm", variant: v })}>
          {t("steps.experiment.action")}
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
                  title={t("traffic.title")}
                  description={t("traffic.description", { name: current.name })}
                  actions={
                    <Link to="/data-sources/$dataSourceId" params={{ dataSourceId: "builtin" }} className={`${linkCls} shrink-0`}>
                      {t("traffic.eventStore")}
                    </Link>
                  }
                />
                <TrafficChart environmentId={current.id} environmentName={current.name} />
              </Panel>
            )}
            <Panel>
              <PanelHeader
                title={t("recentChanges.title")}
                actions={
                  <Link to="/audit" className={`${linkCls} shrink-0`}>
                    {t("recentChanges.auditLog")}
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
