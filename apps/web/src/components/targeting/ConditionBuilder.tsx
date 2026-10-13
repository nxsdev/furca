import type { ConditionOperator } from "@furca/core/targeting/Condition";
import { Button, ComboBox, Header, Input, ListBox, Select, TextField } from "@heroui/react";
import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { type ConditionValue, isListOperator, isPresenceOperator, operatorGroups } from "./summary";

export { type ConditionValue, conditionsSummary, operatorLabels } from "./summary";

type MutableCondition = { attribute: string; operator: ConditionOperator; values: string[] };

const SEMVER = /^v?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Format problems shown inline while typing (empty fields are reported by conditionIssue only) */
const formatIssue = ({ operator, values }: ConditionValue): string | null => {
  const v = values[0] ?? "";
  if (v === "") return null;
  if (operator === "regex") {
    try {
      new RegExp(v);
    } catch {
      return "Not a valid regular expression";
    }
  }
  if ((operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") && !Number.isFinite(Number(v)))
    return "Enter a number";
  if (operator.startsWith("semver_") && !SEMVER.test(v.trim())) return "Use a version like 2.4.0";
  return null;
};

/** Why a condition can't be saved yet, or null when it's complete */
export const conditionIssue = (c: ConditionValue): string | null => {
  if (c.attribute.trim() === "") return "Choose an attribute";
  if (!isPresenceOperator(c.operator) && (c.values[0] ?? "").trim() === "") return "Enter a value";
  return formatIssue(c);
};

const DEFAULT_ATTRIBUTES = ["id", "email", "country", "plan", "version"];

/**
 * AND-ed targeting conditions: attribute (suggestions + free text), operator, value(s).
 * Lists (is one of / is not one of) take several values; presence checks take none
 */
export function ConditionBuilder({
  value,
  onChange,
  attributeSuggestions = DEFAULT_ATTRIBUTES,
  isDisabled = false,
}: {
  value: ReadonlyArray<ConditionValue>;
  onChange: (next: Array<MutableCondition>) => void;
  attributeSuggestions?: ReadonlyArray<string>;
  isDisabled?: boolean;
}) {
  const rows = value.map((c) => ({ attribute: c.attribute, operator: c.operator, values: [...c.values] }));
  const update = (i: number, patch: Partial<MutableCondition>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const setOperator = (i: number, operator: ConditionOperator) => {
    const prev = rows[i]!.values.filter((v) => v !== "");
    update(i, { operator, values: isPresenceOperator(operator) ? [] : isListOperator(operator) ? prev : prev.slice(0, 1) });
  };
  const add = () => onChange([...rows, { attribute: "", operator: "eq", values: [] }]);
  const suggestions = [...new Set([...attributeSuggestions, ...rows.map((r) => r.attribute).filter(Boolean)])];

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <p className="text-label text-muted">Matches everyone. Add a condition to target users by attribute.</p>
      )}
      {rows.map((row, i) => {
        const issue = formatIssue(row);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
          <div key={i} className="grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1fr)_2rem] items-start gap-x-2 gap-y-1.5 sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_2rem]">
            <span className="flex h-8 items-center font-mono text-meta text-muted">{i === 0 ? "if" : "and"}</span>
            <AttributeInput
              value={row.attribute}
              suggestions={suggestions}
              onChange={(attribute) => update(i, { attribute })}
              isDisabled={isDisabled}
            />
            <Select
              aria-label="Operator"
              value={row.operator}
              onChange={(k) => typeof k === "string" && setOperator(i, k as ConditionOperator)}
              isDisabled={isDisabled}
            >
              <Select.Trigger className="h-8 min-h-8 py-1 text-label">
                <Select.Value className="truncate text-label" />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover className="min-w-44">
                <ListBox>
                  {operatorGroups.map((group) => (
                    <ListBox.Section key={group.label}>
                      <Header>{group.label}</Header>
                      {group.items.map(([op, label]) => (
                        <ListBox.Item key={op} id={op} textValue={label} className="text-label">
                          {label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox.Section>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <div className="order-last col-span-3 col-start-2 min-w-0 sm:order-none sm:col-span-1 sm:col-start-auto">
              {isPresenceOperator(row.operator) ? (
                <span className="hidden h-8 items-center text-label text-muted sm:flex">No value needed</span>
              ) : isListOperator(row.operator) ? (
                <TagInput
                  aria-label="Values"
                  values={row.values}
                  onChange={(values) => update(i, { values })}
                  placeholder="Type a value, press Enter"
                  isDisabled={isDisabled}
                  className="font-mono"
                />
              ) : (
                <TextField
                  aria-label="Value"
                  value={row.values[0] ?? ""}
                  onChange={(v) => update(i, { values: [v] })}
                  isInvalid={issue !== null}
                  isDisabled={isDisabled}
                >
                  <Input
                    className="h-8 w-full py-1 font-mono text-base sm:text-label"
                    placeholder={row.operator === "regex" ? "^.+@acme\\.com$" : row.operator.startsWith("semver") ? "2.4.0" : "value"}
                  />
                </TextField>
              )}
              {issue !== null && <p className="mt-1 text-meta text-danger">{issue}</p>}
            </div>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`Remove condition ${i + 1}`}
              className="size-8 min-w-8 text-muted hover:text-foreground"
              onPress={() => onChange(rows.filter((_, j) => j !== i))}
              isDisabled={isDisabled}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="ghost" onPress={add} isDisabled={isDisabled} className="-ml-2 h-7 px-2 text-label text-muted hover:text-foreground">
          <Plus className="size-3.5" />
          Add condition
        </Button>
      </div>
    </div>
  );
}

function AttributeInput({
  value,
  suggestions,
  onChange,
  isDisabled,
}: {
  value: string;
  suggestions: ReadonlyArray<string>;
  onChange: (v: string) => void;
  isDisabled: boolean;
}) {
  return (
    <ComboBox
      aria-label="Attribute"
      allowsCustomValue
      menuTrigger="focus"
      inputValue={value}
      onInputChange={(v) => onChange(v.trim())}
      isDisabled={isDisabled}
    >
      <ComboBox.InputGroup>
        <Input className="h-8 w-full py-1 font-mono text-base sm:text-label" placeholder="attribute" />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover>
        <ListBox>
          {suggestions.map((s) => (
            <ListBox.Item key={s} id={s} textValue={s} className="font-mono text-label">
              {s}
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}

/** Field that collects several short strings as removable chips (Enter, comma or paste to add) */
export function TagInput({
  values,
  onChange,
  placeholder,
  isDisabled = false,
  className = "",
  "aria-label": ariaLabel,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  placeholder?: string;
  isDisabled?: boolean;
  className?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState("");
  const commit = (text: string) => {
    const added = text
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s !== "" && !values.includes(s));
    if (added.length > 0) onChange([...values, ...new Set(added)]);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <div
      className={`flex min-h-8 w-full flex-wrap items-center gap-1 rounded-field border border-[var(--field-border)] bg-field px-1 py-[3px] text-base sm:text-label transition-shadow duration-150 focus-within:ring-2 focus-within:ring-focus ${
        isDisabled ? "pointer-events-none opacity-50" : ""
      } ${className}`}
    >
      {values.map((v) => (
        <span key={v} className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-[4px] bg-default pl-1.5 text-label">
          <span className="truncate">{v}</span>
          <button
            type="button"
            aria-label={`Remove ${v}`}
            disabled={isDisabled}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="flex size-6 shrink-0 items-center justify-center rounded-[4px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        value={draft}
        disabled={isDisabled}
        placeholder={values.length === 0 ? placeholder : undefined}
        onChange={(e) => {
          const text = e.target.value;
          if (/[,\n]/.test(text)) commit(text);
          else setDraft(text);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        className="h-6 min-w-[8ch] flex-1 bg-transparent px-1 outline-none placeholder:font-sans placeholder:text-field-placeholder"
      />
    </div>
  );
}
