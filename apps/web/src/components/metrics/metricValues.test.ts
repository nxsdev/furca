import { describe, expect, it } from "bun:test";
import { i18n } from "~/i18n";
import { advancedSummary, type MetricTemplate, suggestedName, templateFields, toInput, toValues, validate, type Values } from "./metricValues";

await i18n.changeLanguage("en");

/** A new metric from `template` for `event`, as the form leaves it after picking both */
const fromTemplate = (template: MetricTemplate, event: string): Values => {
  const v = { ...toValues(undefined), template, name: "n", key: "k" };
  const fixed = templateFields(template);
  return {
    ...v,
    ...(fixed === null ? {} : { type: fixed.type, inverse: fixed.inverse }),
    num: { ...v.num, event, aggregation: fixed?.aggregation ?? v.num.aggregation },
  };
};

describe("metric templates", () => {
  it("conversion counts users with the event at least once, higher is better", () => {
    const input = toInput(fromTemplate("conversion", "purchase"), false);
    expect(input.type).toBe("proportion");
    expect(input.inverse).toBe(false);
    expect(input.definition).toEqual({
      _tag: "event",
      numerator: { event: "purchase", aggregation: "count", filters: [] },
      denominator: null,
    });
  });

  it("revenue per user averages each user's sum of values", () => {
    const input = toInput(fromTemplate("revenue", "purchase"), false);
    expect(input.type).toBe("mean");
    expect(input.definition).toEqual({
      _tag: "event",
      numerator: { event: "purchase", aggregation: "sum", filters: [] },
      denominator: null,
    });
  });

  it("lower-is-better averages the value per event by dividing by the same event's count", () => {
    const v = fromTemplate("lowerIsBetter", "page_load");
    const input = toInput({ ...v, num: { ...v.num, filters: [{ property: "page", operator: "eq", values: ["/"] }] } }, false);
    expect(input.type).toBe("ratio");
    expect(input.inverse).toBe(true);
    expect(input.definition).toEqual({
      _tag: "event",
      numerator: { event: "page_load", aggregation: "sum", filters: [{ property: "page", operator: "eq", values: ["/"] }] },
      denominator: { event: "page_load", aggregation: "count", filters: [{ property: "page", operator: "eq", values: ["/"] }] },
    });
  });

  it("lower-is-better needs no separate denominator event, a custom ratio does", () => {
    expect(validate(fromTemplate("lowerIsBetter", "page_load"), false, false)).toEqual({});
    const custom = { ...fromTemplate("custom", "purchase"), type: "ratio" as const };
    expect(validate(custom, false, false)["den.event"]).toBeDefined();
  });

  it("suggests a name from the template and event, and none without an event", () => {
    expect(suggestedName("conversion", " purchase ")).toBe("purchase conversion rate");
    expect(suggestedName("custom", "signup")).toBe("signup");
    expect(suggestedName("revenue", "")).toBe("");
  });
});

describe("advancedSummary", () => {
  it("summarizes a new conversion metric's defaults in one line", () => {
    expect(advancedSummary(fromTemplate("conversion", "purchase"), "Built-in events", false)).toBe(
      "Built-in events · 72h after first exposure · no filters",
    );
  });

  it("adds capping for value metrics and the direction when lower is better", () => {
    expect(advancedSummary(fromTemplate("lowerIsBetter", "page_load"), "Built-in events", false)).toBe(
      "Built-in events · 72h after first exposure · no cap · no filters · Lower is better",
    );
  });

  it("reflects a changed window, delay, cap and filters", () => {
    const v = fromTemplate("revenue", "purchase");
    const changed: Values = {
      ...v,
      window: "none",
      delayHours: 2,
      capType: "percentile",
      capPercentile: 99,
      num: { ...v.num, filters: [{ property: "plan", operator: "eq", values: ["pro"] }] },
    };
    expect(advancedSummary(changed, "Warehouse", false)).toBe("Warehouse · No window (from 2h) · At p99 per user · 1 filter");
  });

  it("leaves out filters for SQL sources", () => {
    expect(advancedSummary(fromTemplate("conversion", ""), "BigQuery", true)).toBe("BigQuery · 72h after first exposure");
  });
});
