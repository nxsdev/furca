import type { ChangeRequest } from "@furca/core/approvals/ChangeRequest";
import type { Experiment } from "@furca/core/experiments/Experiment";
import { AlertDialog, Button, Skeleton, Tabs, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Flag, Play, ShieldCheck, SlidersHorizontal, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { StopPanel, TrafficEditor, useReviewRequest } from "~/components/experiments/actions";
import { DecisionBadge, StatusBadge } from "~/components/experiments/parts";
import { HistoryView, PhasesView, SetupView } from "~/components/experiments/tabs";
import { formatDuration, formatList } from "~/components/results/format";
import { ResultsView } from "~/components/results/ResultsView";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Code, PageHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { i18n } from "~/i18n";
import { useEnvironment } from "~/lib/environment";
import { usePermissions } from "~/lib/permissions";
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

type Mode = "view" | "traffic" | "stop";

function Detail({ experiment: x }: { experiment: Experiment }) {
  const { t } = useTranslation(["experiments", "common", "results"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { environments } = useEnvironment();
  const { canEdit } = usePermissions();
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
  // In an environment that requires review, starting files a change request instead
  const review = useReviewRequest(x, () => setConfirm(null));
  const requestStart = useMutation({ mutationFn: () => review.request({ type: "experiment.start", experimentId: x.id }, "") });
  const starting = review.environment === null ? start : requestStart;
  // One open request at a time: further start / traffic / stop actions would only file duplicates
  const pending = (useQuery(orpc.changeRequests.list.queryOptions({ input: { status: "open", featureId: x.featureId } })).data ?? []).filter(
    (r) => "experimentId" in r.change && r.change.experimentId === x.id,
  );
  const blocked = pending.length > 0;

  const actions = !canEdit ? undefined : x.status === "draft" ? (
      <>
        <Button size="sm" variant="ghost" onPress={() => setConfirm("delete")} aria-label={t("detail.actions.deleteDraft")} isIconOnly className="text-muted">
          <Trash2 className="size-4" />
        </Button>
        <Button size="sm" onPress={() => setConfirm("start")} isDisabled={blocked}>
          <Play className="size-3.5" />
          {t("detail.actions.start")}
        </Button>
      </>
    ) : x.status === "running" ? (
      <>
        <Button size="sm" variant="outline" onPress={() => setMode(mode === "traffic" ? "view" : "traffic")} isDisabled={mode === "stop" || blocked}>
          <SlidersHorizontal className="size-3.5" />
          {t("detail.actions.changeTraffic")}
        </Button>
        <Button size="sm" onPress={() => setMode(mode === "stop" ? "view" : "stop")} isDisabled={mode === "traffic" || blocked}>
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
        <p className="-mt-2 mb-6 max-w-[80ch] border-l-2 border-border pl-3 text-body whitespace-pre-line text-muted">
          {x.decision.reason}
          <span className="ml-2 text-meta whitespace-nowrap">
            <Trans t={t} i18nKey="detail.decided" components={{ time: <RelativeTime date={x.decision.decidedAt} /> }} />
          </span>
        </p>
      )}

      <PendingReviews experiment={x} requests={pending} />

      {mode === "traffic" && (
        <div className="mb-6">
          <TrafficEditor experiment={x} onDone={() => setMode("view")} />
        </div>
      )}
      {mode === "stop" && (
        <div className="mb-6">
          <StopPanel experiment={x} feature={feature} snapshot={latest} onDone={() => setMode("view")} />
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
              {review.environment !== null && <p>{t("results:decision.reviewNote", { environment: review.environment.name })}</p>}
              {starting.error !== null && (
                <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
                  {errorMessage(starting.error)}
                </p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" size="sm" isDisabled={starting.isPending}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                size="sm"
                isPending={starting.isPending}
                isDisabled={x.primaryMetricId === null}
                onPress={() => (review.environment === null ? start.mutate({ id: x.id }) : requestStart.mutate())}
              >
                {review.environment === null ? t("detail.start.confirm") : t("results:decision.requestReview")}
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

const pendingAction = (change: ChangeRequest["change"], experiment: Experiment): string => {
  switch (change.type) {
    case "experiment.start":
      return i18n.t("results:decision.pending.start");
    case "experiment.traffic":
      return i18n.t("results:decision.pending.traffic");
    case "experiment.stop":
      return change.outcome === "ship"
        ? i18n.t("results:decision.pending.stopShip", { name: experiment.variations.find((v) => v.key === change.variationKey)?.name ?? change.variationKey ?? "" })
        : change.outcome === "rollback"
          ? i18n.t("results:decision.pending.stopRollback")
          : i18n.t("results:decision.pending.stopInconclusive");
    default:
      return "";
  }
};

/** Start / traffic / stop requests for this experiment waiting for an admin in an environment that requires review */
function PendingReviews({ experiment, requests }: { experiment: Experiment; requests: ReadonlyArray<ChangeRequest> }) {
  const { t } = useTranslation("results");
  const queryClient = useQueryClient();
  const { environments } = useEnvironment();
  const { me, isAdmin } = usePermissions();
  const cancel = useMutation(
    orpc.changeRequests.cancel.mutationOptions({
      onSuccess: () => {
        toast(i18n.t("results:decision.pending.cancelled"));
        void queryClient.invalidateQueries({ queryKey: orpc.changeRequests.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.audit.key() });
      },
      onError: (error) => toast.danger(i18n.t("results:decision.pending.cancelFailed"), { description: errorMessage(error) }),
    }),
  );
  if (requests.length === 0) return null;
  return (
    <section aria-label={t("decision.pending.blocked")} className="mb-6 rounded-[10px] border border-focus/40 bg-focus/[0.04]">
      <ul className="divide-y divide-focus/15">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="flex min-w-0 items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-focus" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-label font-medium">{t("decision.pending.title", { action: pendingAction(r.change, experiment) })}</p>
                <p className="text-meta text-muted">
                  <Trans
                    t={t}
                    i18nKey="decision.pending.by"
                    values={{ email: r.authorEmail, environment: environments.find((e) => e.id === r.environmentId)?.name ?? "" }}
                    components={{ time: <RelativeTime date={r.createdAt} /> }}
                  />
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
              <Link to="/reviews" className="text-label text-focus hover:underline">
                {t("decision.pending.open")}
              </Link>
              {(me?.id === r.authorId || isAdmin) && (
                <Button size="sm" variant="tertiary" onPress={() => cancel.mutate({ id: r.id })} isPending={cancel.isPending && cancel.variables?.id === r.id}>
                  {t("decision.pending.cancel")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="border-t border-focus/15 px-4 py-2 text-meta text-muted sm:px-5">{t("decision.pending.blocked")}</p>
    </section>
  );
}
