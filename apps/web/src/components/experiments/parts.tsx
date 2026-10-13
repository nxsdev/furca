import type { Experiment, ExperimentStatus } from "@furca/core/experiments/Experiment";
import { NumberField, Slider } from "@heroui/react";
import { CircleSlash, Rocket, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "~/components/form/form";

/** Literal class names so Tailwind generates them; variation colors are for identity only */
export const variationBg = ["bg-variation-0", "bg-variation-1", "bg-variation-2", "bg-variation-3", "bg-variation-4"];
export const variationColor = (index: number) => `var(--color-variation-${Math.min(index, 4)})`;
export const MAX_VARIATIONS = 5;

export function VariationSwatch({ index }: { index: number }) {
  return <span aria-hidden="true" className={`inline-block size-2.5 shrink-0 rounded-[3px] ${variationBg[Math.min(index, 4)]}`} />;
}

const statusDot: Record<ExperimentStatus, string> = {
  draft: "border border-muted bg-transparent",
  running: "bg-focus",
  stopped: "bg-muted",
};

export function StatusBadge({ status }: { status: ExperimentStatus }) {
  const { t } = useTranslation("experiments");
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-label">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${statusDot[status]}`} />
      {t(`status.${status}`)}
    </span>
  );
}

/** "Shipped Treatment" / "Rolled back" / "Inconclusive" with an icon (decisions are not verdicts: no color) */
export function DecisionBadge({ experiment }: { experiment: Experiment }) {
  const { t } = useTranslation("experiments");
  const d = experiment.decision;
  if (d === null) return null;
  const variation = experiment.variations.find((v) => v.key === d.variationKey);
  const [Icon, label] =
    d.outcome === "ship"
      ? [Rocket, t("decision.shipped", { name: variation?.name ?? d.variationKey ?? "" }).trim()]
      : d.outcome === "rollback"
        ? [Undo2, t("decision.rolledBack")]
        : [CircleSlash, t("decision.inconclusive")];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-0.5 text-label font-medium">
      <Icon className="size-3.5 text-muted" aria-hidden="true" />
      {label}
    </span>
  );
}

export const currentPhase = (experiment: Experiment) => experiment.phases.at(-1) ?? null;

/** Traffic in effect: the current phase once started, the draft settings before */
export const trafficOf = (experiment: Experiment) => currentPhase(experiment) ?? experiment;

/** Even percentages with 2 decimals that sum to exactly 100 (remainder goes to control) */
export const evenPercents = (n: number): Array<number> => {
  const base = Math.floor(10000 / n) / 100;
  return Array.from({ length: n }, (_, i) => (i === 0 ? Number((100 - base * (n - 1)).toFixed(2)) : base));
};

/** A custom input's error once the field was touched (a submit attempt touches every field), as the form kit shows it */
export const shownError = (meta: { readonly isTouched: boolean; readonly errors: ReadonlyArray<unknown> }): string | null =>
  meta.isTouched ? errorText(meta.errors) || null : null;

export const weightLabel = (w: number) => `${Number((w * 100).toFixed(1))}%`;

/** Coverage 1–100% as slider + exact number (same pattern as flag rollout rules) */
export function CoverageField({ value, onChange, description }: { value: number; onChange: (v: number) => void; description: ReactNode }) {
  const { t } = useTranslation("experiments");
  const percent = Math.round(value * 100);
  const set = (p: number) => Number.isFinite(p) && onChange(Math.min(100, Math.max(1, p)) / 100);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-label font-medium">{t("coverage.label")}</p>
      <div className="flex items-center gap-3">
        <Slider aria-label={t("coverage.label")} value={percent} onChange={(v) => set(Array.isArray(v) ? (v[0] ?? 100) : v)} minValue={1} maxValue={100} className="w-full max-w-72">
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
        <NumberField aria-label={t("coverage.percent")} value={percent} onChange={set} minValue={1} maxValue={100} className="w-24 shrink-0">
          <NumberField.Group className="grid-cols-[1fr_auto]">
            <NumberField.Input className="text-right tabular" />
            <span className="pr-3 text-label text-muted">%</span>
          </NumberField.Group>
        </NumberField>
      </div>
      <p className="text-meta text-muted">{description}</p>
    </div>
  );
}
