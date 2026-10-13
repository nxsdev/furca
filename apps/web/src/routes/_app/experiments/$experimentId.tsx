import type { Experiment } from "@furca/core/experiments/Experiment";
import { AlertDialog, Button, Skeleton, Tabs, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Flag, Pencil, Play, SlidersHorizontal, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { StopPanel, TrafficEditor } from "~/components/experiments/actions";
import { ExperimentForm } from "~/components/experiments/ExperimentForm";
import { DecisionBadge, StatusBadge } from "~/components/experiments/parts";
import { HistoryView, PhasesView, SetupView } from "~/components/experiments/tabs";
import { formatDuration } from "~/components/results/format";
import { ResultsView } from "~/components/results/ResultsView";
import { headlineComparison, isHealthy, regressedGuardrails } from "~/components/results/verdict";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Code, PageHeader, QueryError, RelativeTime } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

type Tab = "results" | "setup" | "phases" | "history";
const tabs: ReadonlyArray<Tab> = ["results", "setup", "phases", "history"];

export const Route = createFileRoute("/_app/experiments/$experimentId")({
  head: () => ({ meta: [{ title: "Experiment · furca" }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    tabs.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {},
  component: Page,
});

const breadcrumb = (
  <Link to="/experiments" className="w-fit text-label text-muted hover:text-foreground">
    Experiments
  </Link>
);

function Page() {
  const { experimentId } = Route.useParams();
  const query = useQuery(orpc.experiments.get.queryOptions({ input: { id: experimentId } }));
  if (query.error !== null)
    return (
      <>
        <PageHeader breadcrumb={breadcrumb} title="Experiment" />
        <QueryError message={errorMessage(query.error)} onRetry={() => query.refetch()} />
      </>
    );
  if (query.isPending)
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading experiment">
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
        toast.success("Experiment started", { description: "Users are being assigned. Results appear as exposures arrive." });
        void navigate({ to: ".", search: { tab: "results" } });
      },
    }),
  );
  const remove = useMutation(
    orpc.experiments.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.experiments.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.features.key() });
        toast("Draft deleted");
        void navigate({ to: "/experiments" });
      },
    }),
  );
  const archive = useMutation(
    orpc.experiments.archive.mutationOptions({
      onSuccess: (next) => {
        saved(next);
        toast(next.archived ? "Archived" : "Restored", { description: next.archived ? "Hidden from the experiments list." : undefined });
      },
      onError: (error) => toast.danger("Could not archive", { description: errorMessage(error) }),
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
        <PageHeader breadcrumb={breadcrumb} title={`Edit ${x.name}`} description="Drafts can change freely; nothing is live until you start." />
        <ExperimentForm
          experiment={x}
          onSaved={(next) => {
            saved(next);
            setMode("view");
            toast.success("Draft saved");
          }}
          onCancel={() => setMode("view")}
        />
      </>
    );

  const actions =
    x.status === "draft" ? (
      <>
        <Button size="sm" variant="ghost" onPress={() => setConfirm("delete")} aria-label="Delete draft" isIconOnly className="text-muted">
          <Trash2 className="size-4" />
        </Button>
        <Button size="sm" variant="outline" onPress={() => setMode("edit")}>
          <Pencil className="size-3.5" />
          Edit
        </Button>
        <Button size="sm" onPress={() => setConfirm("start")}>
          <Play className="size-3.5" />
          Start
        </Button>
      </>
    ) : x.status === "running" ? (
      <>
        <Button size="sm" variant="outline" onPress={() => setMode(mode === "traffic" ? "view" : "traffic")} isDisabled={mode === "stop"}>
          <SlidersHorizontal className="size-3.5" />
          Change traffic
        </Button>
        <Button size="sm" onPress={() => setMode(mode === "stop" ? "view" : "stop")} isDisabled={mode === "traffic"}>
          <Square className="size-3.5" />
          Stop & decide
        </Button>
      </>
    ) : (
      <Button size="sm" variant="outline" onPress={() => archive.mutate({ id: x.id, archived: !x.archived })} isPending={archive.isPending}>
        {x.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        {x.archived ? "Restore" : "Archive"}
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
            {x.archived && <span className="text-label font-normal text-muted">Archived</span>}
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
              {feature?.key ?? "flag"}
            </Link>
            <span className="text-label">{envs.map((e) => e.name).join(", ")}</span>
            {x.status === "running" && x.startedAt !== null && (
              <span className="text-label">Running {formatDuration(x.startedAt, new Date())}</span>
            )}
          </span>
        }
        actions={actions}
      />

      {x.status === "stopped" && x.decision !== null && x.decision.reason !== "" && (
        <p className="-mt-2 mb-6 max-w-[80ch] border-l-2 border-border pl-3 text-body text-muted">
          {x.decision.reason}
          <span className="ml-2 text-meta whitespace-nowrap">
            · decided <RelativeTime date={x.decision.decidedAt} />
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
          <Tabs.List aria-label="Experiment sections" className="min-w-0 gap-1">
            {started && (
              <Tabs.Tab className="w-auto px-2.5 text-label" id="results">
                Results
                <Tabs.Indicator />
              </Tabs.Tab>
            )}
            <Tabs.Tab className="w-auto px-2.5 text-label" id="setup">
              Setup
              <Tabs.Indicator />
            </Tabs.Tab>
            {started && (
              <Tabs.Tab className="w-auto px-2.5 text-label" id="phases">
                Phases <span className="ml-1 font-mono text-meta text-muted tabular">{x.phases.length}</span>
                <Tabs.Indicator />
              </Tabs.Tab>
            )}
            <Tabs.Tab className="w-auto px-2.5 text-label" id="history">
              History
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
              <AlertDialog.Heading className="text-section font-semibold">Start {x.name}?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="flex flex-col gap-3 text-body text-muted">
              <p>
                The experiment rule on <span className="font-mono text-foreground">{feature?.key ?? "the flag"}</span> goes live in{" "}
                {envs.length === 1 ? "1 environment" : `${envs.length} environments`} ({envs.map((e) => e.name).join(", ")}). Matching users are
                assigned to {x.variations.map((v) => v.name).join(" / ")} from now on.
              </p>
              <p>Variations and statistics settings lock so the result can't be tuned after the fact.</p>
              {offIn.length > 0 && (
                <p className="text-foreground">
                  <span className="font-mono">{feature?.key}</span> is off in {offIn.map((e) => e.name).join(", ")}: nobody there is
                  assigned until you turn the flag on.
                </p>
              )}
              {x.primaryMetricId === null && (
                <p className="text-foreground">Set a primary metric first: Edit → Metrics. Starting without one is not allowed.</p>
              )}
              {start.error !== null && (
                <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
                  {errorMessage(start.error)}
                </p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" size="sm" isDisabled={start.isPending}>
                Cancel
              </Button>
              <Button size="sm" isPending={start.isPending} isDisabled={x.primaryMetricId === null} onPress={() => start.mutate({ id: x.id })}>
                Start experiment
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <ConfirmDialog
        isOpen={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        onConfirm={() => remove.mutate({ id: x.id })}
        isPending={remove.isPending}
        error={remove.error === null ? null : errorMessage(remove.error)}
      >
        <p>
          <span className="font-medium text-foreground">{x.name}</span> and its rule on{" "}
          <span className="font-mono">{feature?.key ?? "the flag"}</span> are removed. Nobody was assigned yet, so no data is lost.
        </p>
      </ConfirmDialog>
    </>
  );
}
