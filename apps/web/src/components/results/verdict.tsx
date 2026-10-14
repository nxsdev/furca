import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Metric } from "@furca/core/metrics/Metric";
import type { ExperimentHealth, MetricResult, VariationComparison, Verdict } from "@furca/core/results/ExperimentResult";
import { ArrowDownRight, ArrowUpRight, CircleDashed, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";
import type { Assessment, Progress } from "./decision";
import { formatLift, formatList, formatPercent } from "./format";

export const verdictStyle: Record<Verdict, { text: string; fill: string; band: string; icon: typeof Minus }> = {
  winning: { text: "text-win", fill: "fill-win", band: "fill-win/25", icon: ArrowUpRight },
  losing: { text: "text-lose", fill: "fill-lose", band: "fill-lose/25", icon: ArrowDownRight },
  neutral: { text: "text-muted", fill: "fill-muted", band: "fill-muted/25", icon: Minus },
  inconclusive: { text: "text-muted", fill: "fill-muted", band: "fill-muted/15", icon: CircleDashed },
};

/** "Winning" / "No difference" … in the current language */
export const verdictLabel = (verdict: Verdict): string => i18n.t(`results:verdict.${verdict}`);

/** Icon + label, never color alone */
export function VerdictLabel({ verdict }: { verdict: Verdict }) {
  const { t } = useTranslation("results");
  const s = verdictStyle[verdict];
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-label font-medium ${s.text}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {t(`verdict.${verdict}`)}
    </span>
  );
}

export const isHealthy = (health: ExperimentHealth | null): boolean =>
  health === null || (health.srm.ok && health.multipleExposuresOk);

/** The comparison the verdict banner leads with: strongest winner, else worst loser, else the first */
export function headlineComparison(metric: MetricResult): VariationComparison | null {
  const by = (v: Verdict) => metric.comparisons.filter((c) => c.verdict === v);
  const strongest = (cs: Array<VariationComparison>) => cs.sort((a, b) => Math.abs(b.lift ?? 0) - Math.abs(a.lift ?? 0))[0];
  return strongest(by("winning")) ?? strongest(by("losing")) ?? by("neutral")[0] ?? metric.comparisons[0] ?? null;
}

/** Guardrail metrics where at least one treatment got significantly worse */
export const regressedGuardrails = (metrics: ReadonlyArray<MetricResult>): MetricResult[] =>
  metrics.filter((m) => m.role === "guardrail" && m.comparisons.some((c) => c.verdict === "losing"));

/** "+3.1%, interval +1.2% to +5.0%" (just the lift when there is no interval) */
export const effectText = (c: VariationComparison): string =>
  c.lift === null
    ? "–"
    : c.ci === null
      ? formatLift(c.lift)
      : i18n.t("results:banner.effect", { lift: formatLift(c.lift), lo: formatLift(c.ci[0]), hi: formatLift(c.ci[1]) });

/**
 * The verdict in plain language, shared by the results header, the stop panel and the decision memo.
 * `finished`: the planned sample is reached (or the experiment stopped), so "no difference" is final
 */
export function verdictText(
  a: Assessment,
  experiment: Experiment,
  metrics: ReadonlyMap<string, Metric>,
  finished: boolean,
): { headline: string; guardrails: string | null } {
  const name = experiment.variations.find((v) => v.key === a.comparison?.variationKey)?.name ?? i18n.t("results:banner.treatmentFallback");
  const effect = a.comparison === null ? "" : effectText(a.comparison);
  const headline = {
    noData: () => i18n.t("results:banner.noData"),
    unhealthy: () => i18n.t("results:banner.untrustworthy"),
    noPrimary: () => i18n.t("results:banner.noPrimary"),
    error: () =>
      i18n.t("results:banner.notAnalyzed", { metric: metrics.get(a.primary?.metricId ?? "")?.name ?? i18n.t("results:banner.primaryFallback") }),
    winning: () =>
      i18n.t(a.regressions.length > 0 ? "results:banner.winningRegressed" : "results:banner.winning", { name, effect }),
    losing: () => i18n.t("results:banner.losing", { name, effect }),
    neutral: () => (finished ? i18n.t("results:banner.noDifference") : i18n.t("results:banner.noDifferenceYet")),
    inconclusive: () => i18n.t("results:banner.notEnoughData"),
  }[a.kind]();
  const guardrails =
    a.kind === "noData" || a.kind === "unhealthy"
      ? null
      : a.regressions.length > 0
        ? i18n.t("results:banner.guardrailsRegressed", {
            metrics: formatList(a.regressions.map((m) => metrics.get(m.metricId)?.name ?? i18n.t("results:banner.guardrailFallback"))),
          })
        : experiment.guardrailMetricIds.length === 0
          ? i18n.t("results:banner.guardrailsNone")
          : i18n.t("results:banner.guardrailsOk");
  return { headline, guardrails };
}

/** "Day 2 · 38% of target sample · about 9 days left" (no estimate once stopped) */
export const progressText = (p: Progress, running: boolean): string =>
  [
    i18n.t("results:banner.day", { day: p.day }),
    p.fraction === null ? null : p.fraction >= 1 ? i18n.t("results:banner.reached") : i18n.t("results:banner.progress", { percent: formatPercent(p.fraction, 0) }),
    p.daysLeft === null || !running ? null : i18n.t("results:banner.eta", { count: p.daysLeft }),
  ]
    .filter((x) => x !== null)
    .join(" · ");
