import type { ExperimentHealth, MetricResult, VariationComparison, Verdict } from "@kuji/core/results/ExperimentResult";
import { ArrowDownRight, ArrowUpRight, CircleDashed, Minus } from "lucide-react";

export const verdictStyle: Record<Verdict, { label: string; text: string; fill: string; band: string; icon: typeof Minus }> = {
  winning: { label: "Winning", text: "text-win", fill: "fill-win", band: "fill-win/25", icon: ArrowUpRight },
  losing: { label: "Losing", text: "text-lose", fill: "fill-lose", band: "fill-lose/25", icon: ArrowDownRight },
  neutral: { label: "No difference", text: "text-muted", fill: "fill-muted", band: "fill-muted/25", icon: Minus },
  inconclusive: { label: "Not enough data", text: "text-muted", fill: "fill-muted", band: "fill-muted/15", icon: CircleDashed },
};

/** Icon + label, never color alone */
export function VerdictLabel({ verdict }: { verdict: Verdict }) {
  const s = verdictStyle[verdict];
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-label font-medium ${s.text}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {s.label}
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
