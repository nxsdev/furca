import { Key } from "@furca/api/contract";
import { BUILTIN_DATA_SOURCE_ID } from "@furca/core/datasources/DataSource";
import type { EventAggregation, EventSource, Metric, MetricType } from "@furca/core/metrics/Metric";
import type { DeepKeys } from "@tanstack/react-form";
import { Schema } from "effect";
import { i18n } from "~/i18n";
import type { client } from "~/lib/rpc";
import { cappingLabel, formatHours } from "./describe";
import { type FilterValues, filterIssue, filterValues } from "./PropertyFilters";

export type MetricInput = Omit<Parameters<typeof client.metrics.create>[0], "key">;
export type WindowChoice = "24" | "72" | "168" | "none" | "custom";
type CapType = Metric["capping"]["type"];

/**
 * Starting points of the create form. Each one fixes the type, aggregation and direction so the
 * user only picks an event; "custom" shows those choices instead
 */
export const METRIC_TEMPLATES = ["conversion", "revenue", "lowerIsBetter", "custom"] as const;
export type MetricTemplate = (typeof METRIC_TEMPLATES)[number];

export interface SourceValues {
  event: string;
  aggregation: EventAggregation;
  filters: FilterValues[];
}

export interface Values {
  template: MetricTemplate;
  name: string;
  key: string;
  description: string;
  type: MetricType;
  dataSourceId: string;
  num: SourceValues;
  den: SourceValues;
  numSql: string;
  denSql: string;
  inverse: boolean;
  window: WindowChoice;
  customWindow: number;
  delayHours: number;
  capType: CapType;
  capAbsolute: number;
  capPercentile: number;
}

export const presetWindows: ReadonlyArray<WindowChoice> = ["24", "72", "168"];

const sourceValues = (s: EventSource | null | undefined): SourceValues => ({
  event: s?.event ?? "",
  aggregation: s?.aggregation ?? "count",
  filters: (s?.filters ?? []).map((f) => ({ property: f.property, operator: f.operator, values: [...f.values] })),
});

const filtersInput = (filters: ReadonlyArray<FilterValues>) =>
  filters.map((f) => ({ property: f.property.trim(), operator: f.operator, values: filterValues(f) }));

/** A new metric starts as a conversion rate; an existing one is edited with every choice visible */
export const toValues = (m: Metric | undefined): Values => {
  const d = m?.definition;
  const w = m?.windowHours ?? null;
  return {
    template: m === undefined ? "conversion" : "custom",
    name: m?.name ?? "",
    key: m?.key ?? "",
    description: m?.description ?? "",
    type: m?.type ?? "proportion",
    dataSourceId: m?.dataSourceId ?? BUILTIN_DATA_SOURCE_ID,
    num: sourceValues(d?._tag === "event" ? d.numerator : null),
    den: sourceValues(d?._tag === "event" ? d.denominator : null),
    numSql: d?._tag === "sql" ? d.numeratorSql : "",
    denSql: d?._tag === "sql" ? (d.denominatorSql ?? "") : "",
    inverse: m?.inverse ?? false,
    window: m === undefined ? "72" : w === null ? "none" : presetWindows.includes(String(w) as WindowChoice) ? (String(w) as WindowChoice) : "custom",
    customWindow: w ?? 48,
    delayHours: m?.delayHours ?? 0,
    capType: m?.capping.type ?? "none",
    capAbsolute: m?.capping.type === "absolute" ? m.capping.value : 100,
    capPercentile: m?.capping.type === "percentile" ? Number((m.capping.value * 100).toFixed(2)) : 99,
  };
};

/** The fields a template fixes (custom keeps whatever is set) */
export const templateFields = (template: MetricTemplate): Pick<Values, "type" | "inverse"> & { aggregation: EventAggregation } | null =>
  template === "conversion"
    ? { type: "proportion", aggregation: "count", inverse: false }
    : template === "revenue"
      ? { type: "mean", aggregation: "sum", inverse: false }
      : template === "lowerIsBetter"
        ? // A per-event average (sum of values ÷ number of events), so users who load more pages don't look slower
          { type: "ratio", aggregation: "sum", inverse: true }
        : null;

/** "Lower is better" averages one event: its denominator is the same event, counted */
const mirrorsNumerator = (d: Values) => d.template === "lowerIsBetter";

/** The name a template suggests for an event: "purchase conversion rate" */
export const suggestedName = (template: MetricTemplate, event: string): string =>
  event.trim() === "" ? "" : i18n.t(($) => $.form.templates[template].name, { ns: "metrics", event: event.trim() });

export const windowHoursOf = (d: Values): number | null =>
  d.window === "none" ? null : d.window === "custom" ? d.customWindow : Number(d.window);

export const toInput = (d: Values, isSql: boolean): MetricInput => {
  const num = { event: d.num.event.trim(), aggregation: d.type === "proportion" ? "count" : d.num.aggregation, filters: filtersInput(d.num.filters) } as const;
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    type: d.type,
    dataSourceId: d.dataSourceId,
    definition: isSql
      ? { _tag: "sql", numeratorSql: d.numSql, denominatorSql: d.type === "ratio" ? d.denSql : null }
      : {
          _tag: "event",
          numerator: num,
          denominator:
            d.type !== "ratio"
              ? null
              : mirrorsNumerator(d)
                ? { event: num.event, aggregation: "count", filters: num.filters }
                : { event: d.den.event.trim(), aggregation: d.den.aggregation, filters: filtersInput(d.den.filters) },
        },
    inverse: d.inverse,
    windowHours: windowHoursOf(d),
    delayHours: d.delayHours,
    capping:
      d.type === "proportion" || d.capType === "none"
        ? { type: "none" }
        : d.capType === "absolute"
          ? { type: "absolute", value: d.capAbsolute }
          : { type: "percentile", value: d.capPercentile / 100 },
  };
};

export type FieldErrors = Partial<Record<DeepKeys<Values>, string>>;

/** Fields that live in the collapsed "Advanced" section: it opens when one of them blocks saving */
export const ADVANCED_FIELDS: ReadonlyArray<DeepKeys<Values>> = [
  "description",
  "customWindow",
  "delayHours",
  "capAbsolute",
  "capPercentile",
  "num.filters",
  "den.filters",
];

/** Whole-form rules (they cross fields: type, source, window and delay), run as a form-level validator */
export const validate = (d: Values, isSql: boolean, isEdit: boolean): FieldErrors => {
  const e: FieldErrors = {};
  if (d.name.trim() === "") e.name = i18n.t(($) => $.form.errors.name, { ns: "metrics" });
  // An empty name already has its error; the key follows the name
  if (!isEdit && d.name.trim() !== "" && !Schema.is(Key)(d.key)) e.key = i18n.t(($) => $.form.errors.key, { ns: "metrics" });
  const needsDen = d.type === "ratio" && !mirrorsNumerator(d);
  if (isSql) {
    if (d.numSql.trim() === "") e.numSql = i18n.t(($) => $.form.errors.numSql, { ns: "metrics" });
    if (d.type === "ratio" && d.denSql.trim() === "") e.denSql = i18n.t(($) => $.form.errors.denSql, { ns: "metrics" });
  } else {
    if (d.num.event.trim() === "") e["num.event"] = i18n.t(($) => $.form.errors.numEvent, { ns: "metrics" });
    if (needsDen && d.den.event.trim() === "") e["den.event"] = i18n.t(($) => $.form.errors.denEvent, { ns: "metrics" });
    const numFilters = d.num.filters.map(filterIssue).find((issue) => issue !== null);
    if (numFilters) e["num.filters"] = numFilters;
    const denFilters = needsDen ? d.den.filters.map(filterIssue).find((issue) => issue !== null) : null;
    if (denFilters) e["den.filters"] = denFilters;
  }
  const w = windowHoursOf(d);
  if (w !== null && !(w > 0)) e.customWindow = i18n.t(($) => $.form.errors.window, { ns: "metrics" });
  if (!(d.delayHours >= 0)) e.delayHours = i18n.t(($) => $.form.errors.delayNegative, { ns: "metrics" });
  else if (w !== null && d.delayHours >= w) e.delayHours = i18n.t(($) => $.form.errors.delayTooLong, { ns: "metrics" });
  if (d.type !== "proportion") {
    if (d.capType === "absolute" && !(d.capAbsolute > 0)) e.capAbsolute = i18n.t(($) => $.form.errors.capAbsolute, { ns: "metrics" });
    if (d.capType === "percentile" && !(d.capPercentile >= 50 && d.capPercentile < 100))
      e.capPercentile = i18n.t(($) => $.form.errors.capPercentile, { ns: "metrics" });
  }
  return e;
};

/**
 * The collapsed "Advanced" section in one line, e.g.
 * "Built-in events · 72h after first exposure · no filters". Capping only where it applies,
 * direction only when it isn't the default
 */
export const advancedSummary = (d: Values, sourceName: string, isSql: boolean): string => {
  const w = windowHoursOf(d);
  const filters = isSql ? 0 : d.num.filters.length + (d.type === "ratio" && !mirrorsNumerator(d) ? d.den.filters.length : 0);
  const capping = toInput(d, isSql).capping;
  return [
    sourceName,
    (w === null ? i18n.t(($) => $.form.advanced.windowNone, { ns: "metrics" }) : i18n.t(($) => $.form.advanced.window, { ns: "metrics", window: formatHours(w) })) +
      (d.delayHours > 0 ? i18n.t(($) => $.form.advanced.delay, { ns: "metrics", delay: formatHours(d.delayHours) }) : ""),
    d.type === "proportion" ? null : capping.type === "none" ? i18n.t(($) => $.form.advanced.capNone, { ns: "metrics" }) : cappingLabel(capping),
    isSql ? null : filters === 0 ? i18n.t(($) => $.form.advanced.filtersNone, { ns: "metrics" }) : i18n.t(($) => $.form.advanced.filters, { ns: "metrics", count: filters }),
    d.inverse ? i18n.t(($) => $.direction.lowerIsBetter, { ns: "metrics" }) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};
