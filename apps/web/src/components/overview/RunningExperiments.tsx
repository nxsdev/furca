import { Skeleton } from "@heroui/react";
import type { Experiment } from "@furca/core/experiments/Experiment";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleDashed, TriangleAlert } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { formatCount, formatDuration, formatLift } from "~/components/results/format";
import { headlineComparison, isHealthy, regressedGuardrails, VerdictLabel } from "~/components/results/verdict";
import { Panel, PanelHeader } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { orpc } from "~/lib/rpc";

const linkCls = "rounded-sm text-label text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus";

function Muted({ icon: Icon = CircleDashed, children }: { icon?: typeof CircleDashed; children: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-label text-muted">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

/** Latest stored snapshot only (no analysis is triggered from here) */
function useLatest(experimentId: string) {
  return useQuery(orpc.results.latest.queryOptions({ input: { experimentId } }));
}

function Users({ experimentId }: { experimentId: string }) {
  const latest = useLatest(experimentId);
  const n = latest.data?.health?.totalUsers;
  return <>{n === undefined ? <span className="text-muted">—</span> : formatCount(n)}</>;
}

function PrimaryStatus({ experiment }: { experiment: Experiment }) {
  const { t } = useTranslation("overview");
  const latest = useLatest(experiment.id);
  if (latest.isPending) return <Skeleton className="h-4 w-28 rounded-md" />;
  if (latest.isError) return <span className="text-muted">—</span>;
  const snap = latest.data;
  if (snap === null) return <Muted>{t(($) => $.running.notAnalyzed)}</Muted>;
  if (snap.status === "error") return <Muted icon={CircleAlert}>{t(($) => $.running.analysisFailed)}</Muted>;
  if (!isHealthy(snap.health))
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-label font-medium text-health">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
        {snap.health?.srm.ok === false ? t(($) => $.running.srm) : t(($) => $.running.multipleExposures)}
      </span>
    );
  const primary = snap.metrics.find((m) => m.role === "primary");
  const c = primary === undefined ? null : headlineComparison(primary);
  if (c === null) return <Muted>{t(($) => $.running.noPrimaryResult)}</Muted>;
  return (
    <span className="inline-flex items-center gap-2">
      <VerdictLabel verdict={c.verdict} />
      {c.lift !== null && c.verdict !== "inconclusive" && <span className="font-mono text-muted tabular">{formatLift(c.lift)}</span>}
      {regressedGuardrails(snap.metrics).length > 0 && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-label text-lose">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {t(($) => $.running.guardrailRegressed)}
        </span>
      )}
    </span>
  );
}

export function RunningExperiments({ experiments }: { experiments: ReadonlyArray<Experiment> }) {
  const { t } = useTranslation("overview");
  const running = experiments.filter((x) => x.status === "running");
  const now = new Date();
  return (
    <Panel>
      <PanelHeader
        title={t(($) => $.running.title)}
        description={t(($) => $.running.description)}
        actions={
          <Link to="/experiments" className={`${linkCls} shrink-0`}>
            {t(($) => $.running.all)}
          </Link>
        }
      />
      {running.length === 0 ? (
        <p className="px-5 py-6 text-body text-muted">
          <Trans t={t} i18nKey={($) => $.running.empty} components={{ action: <Link to="/experiments/new" className={linkCls} /> }} />
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>{t(($) => $.running.experiment)}</th>
                <th className={`${tbl.th} hidden sm:table-cell`}>{t(($) => $.running.runningFor)}</th>
                <th className={`${tbl.th} hidden text-right md:table-cell`}>{t(($) => $.running.users)}</th>
                <th className={tbl.th}>{t(($) => $.running.primaryMetric)}</th>
              </tr>
            </thead>
            <tbody>
              {running.map((x) => (
                <tr key={x.id} className={tbl.tr}>
                  <td className={`${tbl.td} max-w-[340px]`}>
                    <Link to="/experiments/$experimentId" params={{ experimentId: x.id }} className={`${tbl.rowLink} block truncate`}>
                      {x.name}
                    </Link>
                    {x.phases.length > 1 && <span className="block text-meta text-muted">{t(($) => $.running.phase, { number: x.phases.length })}</span>}
                  </td>
                  <td className={`${tbl.td} hidden whitespace-nowrap tabular sm:table-cell`}>
                    {x.startedAt === null ? "—" : formatDuration(new Date(x.startedAt), now)}
                  </td>
                  <td className={`${tbl.td} hidden text-right font-mono tabular md:table-cell`}>
                    <Users experimentId={x.id} />
                  </td>
                  <td className={tbl.td}>
                    <PrimaryStatus experiment={x} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
