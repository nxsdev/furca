import type { EventPropertyStat } from "@furca/api/contract";
import type { PropertyFilterOperator } from "@furca/core/metrics/Metric";
import { Button, ComboBox, Input, ListBox, Select } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatCount } from "~/components/results/format";
import { TagInput } from "~/components/targeting/ConditionBuilder";
import { i18n } from "~/i18n";
import { orpc } from "~/lib/rpc";

export interface FilterValues {
  property: string;
  operator: PropertyFilterOperator;
  values: string[];
}

/** Labels come from `targeting:operators` (same words as targeting conditions) */
const OPERATORS: ReadonlyArray<PropertyFilterOperator> = ["eq", "neq", "in", "not_in", "contains", "gt", "gte", "lt", "lte", "exists", "not_exists"];
export const MAX_FILTERS = 10;

const isList = (op: PropertyFilterOperator) => op === "in" || op === "not_in";
const isPresence = (op: PropertyFilterOperator) => op === "exists" || op === "not_exists";
const isNumeric = (op: PropertyFilterOperator) => op === "gt" || op === "gte" || op === "lt" || op === "lte";

/** The values an operator takes: none (presence), a list (in / not in) or exactly one */
export const filterValues = ({ operator, values }: FilterValues): string[] =>
  isPresence(operator) ? [] : isList(operator) ? values.map((v) => v.trim()).filter((v) => v !== "") : [(values[0] ?? "").trim()];

/** Why a filter can't be saved yet (mirrors the API's checks), or null */
export const filterIssue = (f: FilterValues): string | null => {
  if (f.property.trim() === "") return i18n.t(($) => $.form.filters.errors.property, { ns: "metrics" });
  if (/["\\]/.test(f.property)) return i18n.t(($) => $.form.filters.errors.unsupported, { ns: "metrics" });
  if (isPresence(f.operator)) return null;
  const [first = ""] = filterValues(f);
  if (first === "") return i18n.t(($) => $.form.filters.errors.value, { ns: "metrics" });
  if (isNumeric(f.operator) && !Number.isFinite(Number(first))) return i18n.t(($) => $.form.filters.errors.number, { ns: "metrics" });
  return null;
};

/**
 * AND-ed property filters of one event source: property (suggested from the event's recent
 * properties, free text allowed), operator, value(s). Only for built-in event sources
 */
export function PropertyFilters({
  value,
  onChange,
  environmentId,
  event,
  error,
}: {
  value: ReadonlyArray<FilterValues>;
  onChange: (next: FilterValues[]) => void;
  environmentId: string | null;
  /** Suggestions load once this is an event name the environment has received */
  event: string | null;
  error?: string | undefined;
}) {
  const { t } = useTranslation("metrics");
  const { t: tt } = useTranslation("targeting");
  const stats = useQuery({
    ...orpc.events.properties.queryOptions({ input: { environmentId: environmentId ?? "", event: event ?? "" } }),
    enabled: environmentId !== null && event !== null,
  });
  const properties = stats.data ?? [];
  const rows = value.map((f) => ({ ...f, values: [...f.values] }));
  const update = (i: number, patch: Partial<FilterValues>) => onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const setOperator = (i: number, operator: PropertyFilterOperator) => {
    const kept = rows[i]!.values.filter((v) => v !== "");
    update(i, { operator, values: isPresence(operator) ? [] : isList(operator) ? kept : kept.slice(0, 1) });
  };

  return (
    <div className="@container flex flex-col gap-2">
      {rows.map((row, i) => {
        const samples = properties.find((p) => p.property === row.property)?.sampleValues ?? [];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
          <div key={i} className="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)_2rem] items-start gap-x-2 gap-y-1.5 @lg:grid-cols-[3rem_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_2rem]">
            <span className="flex h-8 items-center font-mono text-meta text-muted">{i === 0 ? t(($) => $.form.filters.where) : t(($) => $.form.filters.and)}</span>
            <PropertyInput value={row.property} properties={properties} onChange={(property) => update(i, { property })} />
            <Select
              aria-label={t(($) => $.form.filters.operator)}
              value={row.operator}
              onChange={(k) => typeof k === "string" && setOperator(i, k as PropertyFilterOperator)}
            >
              <Select.Trigger className="h-8 min-h-8 py-1 text-label">
                <Select.Value className="truncate text-label" />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover className="min-w-40">
                <ListBox>
                  {OPERATORS.map((op) => (
                    <ListBox.Item key={op} id={op} textValue={tt(($) => $.operators[op])} className="text-label">
                      {tt(($) => $.operators[op])}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <div className="order-last col-span-3 col-start-2 min-w-0 @lg:order-none @lg:col-span-1 @lg:col-start-auto">
              {isPresence(row.operator) ? (
                <span className="hidden h-8 items-center text-label text-muted @lg:flex">{t(($) => $.form.filters.noValue)}</span>
              ) : isList(row.operator) ? (
                <TagInput
                  aria-label={t(($) => $.form.filters.values)}
                  values={row.values}
                  onChange={(values) => update(i, { values })}
                  placeholder={t(($) => $.form.filters.valuesPlaceholder)}
                  className="font-mono"
                />
              ) : (
                <ComboBox
                  aria-label={t(($) => $.form.filters.value)}
                  allowsCustomValue
                  menuTrigger="focus"
                  inputValue={row.values[0] ?? ""}
                  onInputChange={(v) => update(i, { values: [v] })}
                >
                  <ComboBox.InputGroup>
                    <Input
                      inputMode={isNumeric(row.operator) ? "decimal" : undefined}
                      placeholder={isNumeric(row.operator) ? "10" : "pro"}
                      className="h-8 w-full py-1 font-mono text-base sm:text-label"
                    />
                    {samples.length > 0 && <ComboBox.Trigger />}
                  </ComboBox.InputGroup>
                  <ComboBox.Popover>
                    <ListBox>
                      {samples.map((s) => (
                        <ListBox.Item key={s} id={s} textValue={s} className="font-mono text-label">
                          {s}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </ComboBox.Popover>
                </ComboBox>
              )}
            </div>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={t(($) => $.form.filters.remove, { number: i + 1 })}
              className="size-8 min-w-8 text-muted hover:text-foreground"
              onPress={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        );
      })}
      {error !== undefined && <p className="text-meta text-danger">{error}</p>}
      <div>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => onChange([...rows, { property: "", operator: "eq", values: [] }])}
          isDisabled={rows.length >= MAX_FILTERS}
          className="-ml-2 h-7 px-2 text-label text-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t(($) => $.form.filters.add)}
        </Button>
      </div>
    </div>
  );
}

function PropertyInput({
  value,
  properties,
  onChange,
}: {
  value: string;
  properties: ReadonlyArray<EventPropertyStat>;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation("metrics");
  return (
    <ComboBox aria-label={t(($) => $.form.filters.property)} allowsCustomValue menuTrigger="focus" inputValue={value} onInputChange={(v) => onChange(v.trim())}>
      <ComboBox.InputGroup>
        <Input className="h-8 w-full py-1 font-mono text-base sm:text-label" placeholder="plan" spellCheck={false} />
        {properties.length > 0 && <ComboBox.Trigger />}
      </ComboBox.InputGroup>
      <ComboBox.Popover className="min-w-56">
        <ListBox>
          {properties.map((p) => (
            <ListBox.Item key={p.property} id={p.property} textValue={p.property} className="gap-3">
              <span className="min-w-0 flex-1 truncate font-mono text-label">{p.property}</span>
              <span className="shrink-0 text-meta text-muted tabular">{t(($) => $.form.filters.seen, { count: p.count, events: formatCount(p.count) })}</span>
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}
