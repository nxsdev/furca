import type { ExperimentHealth, MetricResult, VariationComparison, Verdict } from "@furca/core/results/ExperimentResult";
import { ArrowDownRight, ArrowUpRight, CircleDashed, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";

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
