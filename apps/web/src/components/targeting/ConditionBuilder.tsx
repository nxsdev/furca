import type { ConditionOperator } from "@furca/core/targeting/Condition";
import { Button, ComboBox, Header, Input, ListBox, Select, TextField } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";
import { orpc } from "~/lib/rpc";
import { type ConditionValue, isGroupOperator, isListOperator, isPresenceOperator, operatorGroups } from "./summary";

export { type ConditionValue, conditionsSummary, useConditionsSummary } from "./summary";

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
      return i18n.t(($) => $.issues.invalidRegex, { ns: "targeting" });
    }
  }
  if ((operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") && !Number.isFinite(Number(v)))
    return i18n.t(($) => $.issues.enterNumber, { ns: "targeting" });
  if (operator.startsWith("semver_") && !SEMVER.test(v.trim())) return i18n.t(($) => $.issues.invalidVersion, { ns: "targeting" });
  return null;
};

/** Why a condition can't be saved yet, or null when it's complete */
export const conditionIssue = (c: ConditionValue): string | null => {
  if (isGroupOperator(c.operator)) return (c.values[0] ?? "") === "" ? i18n.t(($) => $.issues.chooseGroup, { ns: "targeting" }) : null;
  if (c.attribute.trim() === "") return i18n.t(($) => $.issues.chooseAttribute, { ns: "targeting" });
  if (!isPresenceOperator(c.operator) && (c.values[0] ?? "").trim() === "") return i18n.t(($) => $.issues.enterValue, { ns: "targeting" });
  return formatIssue(c);
};

const DEFAULT_ATTRIBUTES = ["id", "email", "country", "plan", "version"];

/**
 * AND-ed targeting conditions: attribute (suggestions + free text), operator, value(s).
 * Lists (is one of / is not one of) take several values; presence checks take none;
 * saved group operators replace attribute and value with a group picker
 */
export function ConditionBuilder({
  value,
  onChange,
  attributeSuggestions = DEFAULT_ATTRIBUTES,
  isDisabled = false,
  allowGroups = true,
}: {
  value: ReadonlyArray<ConditionValue>;
  onChange: (next: Array<MutableCondition>) => void;
  attributeSuggestions?: ReadonlyArray<string>;
  isDisabled?: boolean;
  /** Off inside a saved group's own conditions (groups cannot nest) */
  allowGroups?: boolean;
}) {
  const { t } = useTranslation("targeting");
  const rows = value.map((c) => ({ attribute: c.attribute, operator: c.operator, values: [...c.values] }));
  const update = (i: number, patch: Partial<MutableCondition>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const setOperator = (i: number, operator: ConditionOperator) => {
    const row = rows[i]!;
    if (isGroupOperator(operator) !== isGroupOperator(row.operator)) {
      // Switching between attribute and group conditions: nothing carries over
      update(i, { operator, attribute: isGroupOperator(operator) ? "" : row.attribute, values: [] });
      return;
    }
    const prev = row.values.filter((v) => v !== "");
    update(i, { operator, values: isPresenceOperator(operator) ? [] : isListOperator(operator) ? prev : prev.slice(0, 1) });
  };
  const groups = operatorGroups.filter((g) => allowGroups || g.id !== "savedGroups");
  const add = () => onChange([...rows, { attribute: "", operator: "eq", values: [] }]);
  const suggestions = [...new Set([...attributeSuggestions, ...rows.map((r) => r.attribute).filter(Boolean)])];

  return (
    <div className="@container flex flex-col gap-2">
      {rows.length === 0 && (
        <p className="text-label text-muted">{t(($) => $.conditionBuilder.empty)}</p>
      )}
      {rows.map((row, i) => {
        const issue = formatIssue(row);
        const operatorSelect = (
          <Select
            aria-label={t(($) => $.conditionBuilder.operator)}
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
                {groups.map((group) => (
                  <ListBox.Section key={group.id}>
                    <Header>{t(($) => $.operatorGroups[group.id])}</Header>
                    {group.operators.map((op) => (
                      <ListBox.Item key={op} id={op} textValue={t(($) => $.operators[op])} className="text-label">
                        {t(($) => $.operators[op])}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox.Section>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        );
        const removeButton = (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={t(($) => $.conditionBuilder.removeCondition, { number: i + 1 })}
            className="size-8 min-w-8 text-muted hover:text-foreground"
            onPress={() => onChange(rows.filter((_, j) => j !== i))}
            isDisabled={isDisabled}
          >
            <X className="size-3.5" />
          </Button>
        );
        const label = (
          <span className="flex h-8 items-center font-mono text-meta text-muted">{i === 0 ? t(($) => $.conditionBuilder.if) : t(($) => $.conditionBuilder.and)}</span>
        );
        if (isGroupOperator(row.operator))
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
            <div key={i} className="grid grid-cols-[2.25rem_minmax(0,1fr)_2rem] items-start gap-x-2 gap-y-1.5 @md:grid-cols-[2.25rem_minmax(0,0.9fr)_minmax(0,2.4fr)_2rem]">
              {label}
              {operatorSelect}
              {/* Below the operator while the builder is narrow (e.g. the flag rules column) */}
              <div className="order-last col-start-2 min-w-0 @md:order-none @md:col-start-auto">
                <GroupPicker value={row.values[0] ?? ""} onChange={(id) => update(i, { values: [id] })} isDisabled={isDisabled} />
              </div>
              {removeButton}
            </div>
          );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
          <div key={i} className="grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1fr)_2rem] items-start gap-x-2 gap-y-1.5 sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_2rem]">
            {label}
            <AttributeInput
              value={row.attribute}
              suggestions={suggestions}
              onChange={(attribute) => update(i, { attribute })}
              isDisabled={isDisabled}
            />
            {operatorSelect}
            <div className="order-last col-span-3 col-start-2 min-w-0 sm:order-none sm:col-span-1 sm:col-start-auto">
              {isPresenceOperator(row.operator) ? (
                <span className="hidden h-8 items-center text-label text-muted sm:flex">{t(($) => $.conditionBuilder.noValueNeeded)}</span>
              ) : isListOperator(row.operator) ? (
                <TagInput
                  aria-label={t(($) => $.conditionBuilder.values)}
                  values={row.values}
                  onChange={(values) => update(i, { values })}
                  placeholder={t(($) => $.conditionBuilder.valuesPlaceholder)}
                  isDisabled={isDisabled}
                  className="font-mono"
                />
              ) : (
                <TextField
                  aria-label={t(($) => $.conditionBuilder.value)}
                  value={row.values[0] ?? ""}
                  onChange={(v) => update(i, { values: [v] })}
                  isInvalid={issue !== null}
                  isDisabled={isDisabled}
                >
                  <Input
                    className="h-8 w-full py-1 font-mono text-base sm:text-label"
                    placeholder={row.operator === "regex" ? "^.+@acme\\.com$" : row.operator.startsWith("semver") ? "2.4.0" : t(($) => $.conditionBuilder.valuePlaceholder)}
                  />
                </TextField>
              )}
              {issue !== null && <p className="mt-1 text-meta text-danger">{issue}</p>}
            </div>
            {removeButton}
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="ghost" onPress={add} isDisabled={isDisabled} className="-ml-2 h-7 px-2 text-label text-muted hover:text-foreground">
          <Plus className="size-3.5" />
          {t(($) => $.conditionBuilder.addCondition)}
        </Button>
      </div>
    </div>
  );
}

/** Select of saved groups; teaches where to create one when there are none */
function GroupPicker({ value, onChange, isDisabled }: { value: string; onChange: (id: string) => void; isDisabled: boolean }) {
  const { t } = useTranslation("targeting");
  const groups = useQuery(orpc.savedGroups.list.queryOptions());
  if (groups.isSuccess && groups.data.length === 0)
    return (
      <p className="flex min-h-8 items-center text-label text-muted">
        <Link to="/saved-groups" search={{ new: true }} className="text-link hover:underline">
          {t(($) => $.conditionBuilder.createGroup)}
        </Link>
      </p>
    );
  const missing = value !== "" && groups.isSuccess && !groups.data.some((g) => g.id === value);
  return (
    <div className="min-w-0">
      <Select
        aria-label={t(($) => $.conditionBuilder.group)}
        value={value === "" || missing ? null : value}
        onChange={(k) => typeof k === "string" && onChange(k)}
        placeholder={groups.isPending ? t(($) => $.conditionBuilder.loadingGroups) : t(($) => $.conditionBuilder.groupPlaceholder)}
        isDisabled={isDisabled || groups.isPending}
        isInvalid={missing}
      >
        <Select.Trigger className="h-8 min-h-8 py-1 text-label">
          <Select.Value className="truncate text-label" />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="min-w-56">
          <ListBox>
            {(groups.data ?? []).map((g) => (
              <ListBox.Item key={g.id} id={g.id} textValue={g.name} className="text-label">
                <span className="flex-1 truncate">{g.name}</span>
                <span className="text-meta text-muted tabular">
                  {g.type === "list" ? t(($) => $.conditionBuilder.listSize, { count: g.values.length }) : t(($) => $.conditionBuilder.conditionGroup)}
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {missing && <p className="mt-1 text-meta text-danger">{t(($) => $.issues.groupMissing)}</p>}
      {groups.isError && <p className="mt-1 text-meta text-danger">{t(($) => $.issues.groupsFailed)}</p>}
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
  const { t } = useTranslation("targeting");
  return (
    <ComboBox
      aria-label={t(($) => $.conditionBuilder.attribute)}
      allowsCustomValue
      menuTrigger="focus"
      inputValue={value}
      onInputChange={(v) => onChange(v.trim())}
      isDisabled={isDisabled}
    >
      <ComboBox.InputGroup>
        <Input className="h-8 w-full py-1 font-mono text-base sm:text-label" placeholder={t(($) => $.conditionBuilder.attributePlaceholder)} />
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
  const { t } = useTranslation("targeting");
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
            aria-label={t(($) => $.tagInput.remove, { value: v })}
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
