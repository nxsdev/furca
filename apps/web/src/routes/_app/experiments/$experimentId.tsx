import type { Experiment } from "@furca/core/experiments/Experiment";
import { AlertDialog, Button, Skeleton, Tabs, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Flag, Pencil, Play, SlidersHorizontal, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { StopPanel, TrafficEditor } from "~/components/experiments/actions";
import { ExperimentForm } from "~/components/experiments/ExperimentForm";
import { DecisionBadge, StatusBadge } from "~/components/experiments/parts";
import { HistoryView, PhasesView, SetupView } from "~/components/experiments/tabs";
import { formatDuration, formatList } from "~/components/results/format";
import { ResultsView } from "~/components/results/ResultsView";
import { headlineComparison, isHealthy, regressedGuardrails } from "~/components/results/verdict";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Code, PageHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

type Tab = "results" | "setup" | "phases" | "history";
const tabs: ReadonlyArray<Tab> = ["results", "setup", "phases", "history"];

export const Route = createFileRoute("/_app/experiments/$experimentId")({
  head: () => ({ meta: [{ title: i18n.t("experiments:pageTitle.detail") }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    tabs.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {},
  component: Page,
});

function Breadcrumb() {
  const { t } = useTranslation("experiments");
  return (
    <Link to="/experiments" className="w-fit text-label text-muted hover:text-foreground">
      {t("breadcrumb")}
    </Link>
  );
}

const breadcrumb = <Breadcrumb />;

function Page() {
  const { t } = useTranslation("experiments");
  const { experimentId } = Route.useParams();
  const query = useQuery(orpc.experiments.get.queryOptions({ input: { id: experimentId } }));
  if (query.error !== null)
    return (
      <>
        <PageHeader breadcrumb={breadcrumb} title={t("detail.title")} />
        <QueryError message={errorMessage(query.error)} onRetry={() => query.refetch()} />
      </>
    );
  if (query.isPending)
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t("detail.loading")}>
        <Skeleton className="h-4 w-24 rounded-md" />
        <Skeleton className="h-7 w-72 rounded-md" />
        <Skeleton className="h-4 w-96 max-w-full rounded-md" />
        <Skeleton className="mt-6 h-9 w-80 rounded-md" />
        <Skeleton className="h-40 rounded-[10px]" />
      </div>
    );
  return <Detail experiment={query.data} />;
}

type Mode = "view" | "edit" | "traffic" | "stop";

function Detail({ experiment: x }: { experiment: Experiment }) {
  const { t } = useTranslation(["experiments", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { environments } = useEnvironment();
  const search = Route.useSearch();
  const [mode, setMode] = useState<Mode>("view");
  const [confirm, setConfirm] = useState<"start" | "delete" | null>(null);
  const started = x.status !== "draft";
  const tab: Tab = search.tab ?? (started ? "results" : "setup");
  const feature = useQuery(orpc.features.get.queryOptions({ input: { id: x.featureId } })).data;
  const latest = useQuery({ ...orpc.results.latest.queryOptions({ input: { experimentId: x.id } }), enabled: started }).data;

  const saved = (next: Experiment) => {
    queryClient.setQueryData(orpc.experiments.get.queryKey({ input: { id: next.id } }), next);
    void queryClient.invalidateQueries({ queryKey: orpc.experiments.list.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
  };
  const start = useMutation(
    orpc.experiments.start.mutationOptions({
      onSuccess: (next) => {
        saved(next);
        setConfirm(null);
        toast.success(i18n.t("experiments:detail.toast.started"), { description: i18n.t("experiments:detail.toast.startedDescription") });
        void navigate({ to: ".", search: { tab: "results" } });
      },
    }),
  );
  const remove = useMutation(
    orpc.experiments.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.experiments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
        toast(i18n.t("experiments:detail.toast.deleted"));
        void navigate({ to: "/experiments" });
      },
    }),
  );
  const archive = useMutation(
    orpc.experiments.archive.mutationOptions({
      onSuccess: (next) => {
        saved(next);
        toast(i18n.t(next.archived ? "experiments:detail.toast.archived" : "experiments:detail.toast.restored"), {
          description: next.archived ? i18n.t("experiments:detail.toast.archivedDescription") : undefined,
        });
      },
      onError: (error) => toast.danger(i18n.t("experiments:detail.toast.archiveFailed"), { description: errorMessage(error) }),
    }),
  );

  const envs = environments.filter((e) => x.environmentIds.includes(e.id));
  const offIn = envs.filter((e) => feature !== undefined && feature.environments.find((c) => c.environmentId === e.id)?.enabled !== true);
  const primary = latest?.metrics.find((m) => m.role === "primary");
  const head = primary === undefined ? null : headlineComparison(primary);
  const suggestion =
    latest == null || latest.status !== "ok" || !isHealthy(latest.health) || head === null
      ? null
      : head.verdict === "winning"
        ? // Never pre-select shipping over a guardrail regression; the team decides that trade-off
          regressedGuardrails(latest.metrics).length > 0
          ? null
          : `ship:${head.variationKey}`
        : head.verdict === "losing"
          ? "rollback"
          : null;

  if (mode === "edit")
    return (
      <>
        <PageHeader breadcrumb={breadcrumb} title={t("detail.editTitle", { name: x.name })} description={t("detail.editDescription")} />
        <ExperimentForm
          experiment={x}
          onSaved={(next) => {
            saved(next);
            setMode("view");
            toast.success(t("detail.toast.saved"));
          }}
          onCancel={() => setMode("view")}
        />
      </>
    );

  const actions =
    x.status === "draft" ? (
      <>
        <Button size="sm" variant="ghost" onPress={() => setConfirm("delete")} aria-label={t("detail.actions.deleteDraft")} isIconOnly className="text-muted">
          <Trash2 className="size-4" />
        </Button>
        <Button size="sm" variant="outline" onPress={() => setMode("edit")}>
          <Pencil className="size-3.5" />
          {t("common:actions.edit")}
        </Button>
        <Button size="sm" onPress={() => setConfirm("start")}>
          <Play className="size-3.5" />
          {t("detail.actions.start")}
        </Button>
      </>
    ) : x.status === "running" ? (
      <>
        <Button size="sm" variant="outline" onPress={() => setMode(mode === "traffic" ? "view" : "traffic")} isDisabled={mode === "stop"}>
          <SlidersHorizontal className="size-3.5" />
          {t("detail.actions.changeTraffic")}
        </Button>
        <Button size="sm" onPress={() => setMode(mode === "stop" ? "view" : "stop")} isDisabled={mode === "traffic"}>
          <Square className="size-3.5" />
          {t("detail.actions.stopAndDecide")}
        </Button>
      </>
    ) : (
      <Button size="sm" variant="outline" onPress={() => archive.mutate({ id: x.id, archived: !x.archived })} isPending={archive.isPending}>
        {x.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        {x.archived ? t("common:actions.restore") : t("common:actions.archive")}
      </Button>
    );

  return (
    <>
      <PageHeader
        breadcrumb={breadcrumb}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {x.name}
            <span className="text-body font-normal">
              <StatusBadge status={x.status} />
            </span>
            {x.status === "stopped" && <DecisionBadge experiment={x} />}
            {x.archived && <span className="text-label font-normal text-muted">{t("detail.archivedBadge")}</span>}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Code copy>{x.key}</Code>
            <Link
              to="/flags/$featureId"
              params={{ featureId: x.featureId }}
              className="inline-flex items-center gap-1 font-mono text-label text-foreground hover:underline"
            >
              <Flag className="size-3.5 text-muted" aria-hidden="true" />
              {feature?.key ?? t("detail.flagFallback")}
            </Link>
            <span className="text-label">{formatList(envs.map((e) => e.name))}</span>
            {x.status === "running" && x.startedAt !== null && (
              <span className="text-label">{t("detail.runningFor", { duration: formatDuration(x.startedAt, new Date()) })}</span>
            )}
          </span>
        }
        actions={actions}
      />

      {x.status === "stopped" && x.decision !== null && x.decision.reason !== "" && (
        <p className="-mt-2 mb-6 max-w-[80ch] border-l-2 border-border pl-3 text-body text-muted">
          {x.decision.reason}
          <span className="ml-2 text-meta whitespace-nowrap">
            <Trans t={t} i18nKey="detail.decided" components={{ time: <RelativeTime date={x.decision.decidedAt} /> }} />
          </span>
        </p>
      )}

      {mode === "traffic" && (
        <div className="mb-6">
          <TrafficEditor experiment={x} onDone={() => setMode("view")} />
        </div>
      )}
      {mode === "stop" && (
        <div className="mb-6">
          <StopPanel experiment={x} feature={feature} suggestion={suggestion} onDone={() => setMode("view")} />
        </div>
      )}

      <Tabs variant="secondary" selectedKey={tab} onSelectionChange={(k) => void navigate({ to: ".", search: { tab: k as Tab }, replace: true })}>
        <Tabs.ListContainer className="mb-6">
          <Tabs.List aria-label={t("detail.tabs.label")} className="min-w-0 gap-1">
            {started && (
              <Tabs.Tab className="w-auto px-2.5 text-label" id="results">
                {t("detail.tabs.results")}
                <Tabs.Indicator />
              </Tabs.Tab>
            )}
            <Tabs.Tab className="w-auto px-2.5 text-label" id="setup">
              {t("detail.tabs.setup")}
              <Tabs.Indicator />
            </Tabs.Tab>
            {started && (
              <Tabs.Tab className="w-auto px-2.5 text-label" id="phases">
                {t("detail.tabs.phases")} <span className="ml-1 font-mono text-meta text-muted tabular">{x.phases.length}</span>
                <Tabs.Indicator />
              </Tabs.Tab>
            )}
            <Tabs.Tab className="w-auto px-2.5 text-label" id="history">
              {t("detail.tabs.history")}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        {started && (
          <Tabs.Panel className="p-0" id="results">
            <ResultsView experiment={x} feature={feature} />
          </Tabs.Panel>
        )}
        <Tabs.Panel className="p-0" id="setup">
          <SetupView experiment={x} feature={feature} />
        </Tabs.Panel>
        {started && (
          <Tabs.Panel className="p-0" id="phases">
            <PhasesView experiment={x} />
          </Tabs.Panel>
        )}
        <Tabs.Panel className="p-0" id="history">
          <HistoryView experiment={x} />
        </Tabs.Panel>
      </Tabs>

      <AlertDialog.Backdrop isOpen={confirm === "start"} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading className="text-section font-semibold">{t("detail.start.title", { name: x.name })}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="flex flex-col gap-3 text-body text-muted">
              <p>
                <Trans
                  t={t}
                  i18nKey="detail.start.body"
                  count={envs.length}
                  values={{
                    flag: feature?.key ?? t("theFlag"),
                    environments: formatList(envs.map((e) => e.name)),
                    variations: x.variations.map((v) => v.name).join(" / "),
                  }}
                  components={{ code: <span className="font-mono text-foreground" /> }}
                />
              </p>
              <p>{t("detail.start.locks")}</p>
              {offIn.length > 0 && (
                <p className="text-foreground">
                  <Trans
                    t={t}
                    i18nKey="detail.start.flagOff"
                    values={{ flag: feature?.key ?? "", environments: formatList(offIn.map((e) => e.name)) }}
                    components={{ code: <span className="font-mono" /> }}
                  />
                </p>
              )}
              {x.primaryMetricId === null && <p className="text-foreground">{t("detail.start.needsPrimary")}</p>}
              {start.error !== null && (
                <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
                  {errorMessage(start.error)}
                </p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" size="sm" isDisabled={start.isPending}>
                {t("common:actions.cancel")}
              </Button>
              <Button size="sm" isPending={start.isPending} isDisabled={x.primaryMetricId === null} onPress={() => start.mutate({ id: x.id })}>
                {t("detail.start.confirm")}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <ConfirmDialog
        isOpen={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("detail.delete.title")}
        confirmLabel={t("detail.actions.deleteDraft")}
        onConfirm={() => remove.mutate({ id: x.id })}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
      >
        <p>
          <Trans
            t={t}
            i18nKey="detail.delete.body"
            values={{ name: x.name, flag: feature?.key ?? t("theFlag") }}
            components={{ name: <span className="font-medium text-foreground" />, code: <span className="font-mono" /> }}
          />
        </p>
      </ConfirmDialog>
    </>
  );
}
