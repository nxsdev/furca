import type { Experiment } from "@furca/core/experiments/Experiment";
import type { Metric, MetricType } from "@furca/core/metrics/Metric";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { i18n, intlLocale } from "~/i18n";

export const metricTypeLabel = (type: MetricType): string => i18n.t(`metrics:types.${type}`);

/** 24h, 72h, 7d, 14d (24時間, 7日 in Japanese) */
export const formatHours = (hours: number): string => {
  const days = hours >= 168 && hours % 24 === 0;
  return new Intl.NumberFormat(intlLocale(), {
    style: "unit",
    unit: days ? "day" : "hour",
    unitDisplay: "narrow",
    maximumFractionDigits: 2,
  }).format(days ? hours / 24 : hours);
};

export const windowLabel = (m: Pick<Metric, "windowHours" | "delayHours">): string => {
  const window = m.windowHours === null ? i18n.t("metrics:window.none") : formatHours(m.windowHours);
  return m.delayHours > 0 ? i18n.t("metrics:window.withDelay", { window, delay: formatHours(m.delayHours) }) : window;
};

const percentileOf = (value: number) => Number((value * 100).toFixed(2));

export const cappingLabel = (capping: Metric["capping"]): string =>
  capping.type === "none"
    ? i18n.t("common:states.none")
    : capping.type === "absolute"
      ? i18n.t("metrics:capping.absolute", { value: capping.value })
      : i18n.t("metrics:capping.percentile", { percentile: percentileOf(capping.value) });

const tok = <code className="rounded-[4px] bg-default px-1 py-px font-mono text-[0.92em]" />;

type Describable = Pick<Metric, "type" | "definition" | "windowHours" | "delayHours" | "capping">;

/**
 * The metric in one plain sentence, e.g. "Share of users with ≥1 `purchase` within 72h of first
 * exposure". Shared by the form preview, the list and the detail page so they never disagree
 */
export function MetricSentence({ metric }: { metric: Describable }) {
  const { t } = useTranslation("metrics");
  const d = metric.definition;
  const ev = (name: string) => (name.trim() === "" ? t("sentence.eventPlaceholder") : name.trim());
  let what: ReactNode;
  if (d._tag === "event") {
    if (metric.type === "proportion")
      what = <Trans t={t} i18nKey="sentence.proportion" values={{ event: ev(d.numerator.event) }} components={{ c: tok }} />;
    else if (metric.type === "mean")
      what = (
        <Trans
          t={t}
          i18nKey={d.numerator.aggregation === "count" ? "sentence.meanCount" : "sentence.meanSum"}
          values={{ event: ev(d.numerator.event) }}
          components={{ c: tok }}
        />
      );
    else {
      const den = d.denominator ?? { event: "", aggregation: "count" as const };
      const combo = `${d.numerator.aggregation === "count" ? "count" : "sum"}${den.aggregation === "count" ? "Count" : "Sum"}` as const;
      what = (
        <Trans
          t={t}
          i18nKey={`sentence.ratio.${combo}`}
          values={{ numerator: ev(d.numerator.event), denominator: ev(den.event) }}
          components={{ c: tok }}
        />
      );
    }
  } else {
    what = (
      <Trans
        t={t}
        i18nKey={metric.type === "proportion" ? "sentence.sqlProportion" : metric.type === "mean" ? "sentence.sqlMean" : "sentence.sqlRatio"}
        components={{ c: tok }}
      />
    );
  }

  const delay = metric.delayHours > 0 ? formatHours(metric.delayHours) : null;
  const window = metric.windowHours === null ? null : formatHours(metric.windowHours);
  const when =
    window === null
      ? delay === null
        ? t("sentence.when.anyTime")
        : t("sentence.when.fromDelay", { delay })
      : delay === null
        ? t("sentence.when.within", { window })
        : t("sentence.when.between", { delay, window });

  const cap =
    metric.type === "proportion" || metric.capping.type === "none"
      ? ""
      : metric.capping.type === "absolute"
        ? t("sentence.cap.absolute", { value: metric.capping.value })
        : t("sentence.cap.percentile", { percentile: percentileOf(metric.capping.value) });

  return (
    <>
      {what}
      {t("sentence.tail", { when, cap })}
    </>
  );
}

export function Direction({ inverse }: { inverse: boolean }) {
  const { t } = useTranslation("metrics");
  const Icon = inverse ? ArrowDown : ArrowUp;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon className="size-3.5 text-muted" aria-hidden="true" />
      {inverse ? t("direction.lowerIsBetter") : t("direction.higherIsBetter")}
    </span>
  );
}

/** Experiments that reference each metric (any role), keyed by metric id */
export const usageByMetric = (experiments: ReadonlyArray<Experiment>) => {
  const usage = new Map<string, Array<Experiment>>();
  for (const x of experiments) {
    const ids = new Set([x.primaryMetricId, ...x.secondaryMetricIds, ...x.guardrailMetricIds]);
    for (const id of ids) if (id !== null) usage.set(id, [...(usage.get(id) ?? []), x]);
  }
  return usage;
};
