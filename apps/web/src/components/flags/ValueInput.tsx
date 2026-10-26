import { type FeatureValueType, validateFeatureValue } from "@furca/core/features/Feature";
import { Button, Input, Label, NumberField, TextArea, TextField } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";
import { Segmented } from "./Segmented";

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/** JSON-encoded starting value for a new flag or rule of this type */
export const defaultValueFor = (valueType: FeatureValueType): string =>
  valueType === "boolean" ? "false" : valueType === "string" ? '""' : valueType === "number" ? "0" : "{}";

/** validateFeatureValue (core, English) with a translated message */
export const valueIssue = (valueType: FeatureValueType, json: string): string | null => {
  if (validateFeatureValue(valueType, json) === null) return null;
  if (parse(json) === undefined) return i18n.t(($) => $.value.invalidJson, { ns: "flags" });
  return valueType === "boolean"
    ? i18n.t(($) => $.value.expectedBoolean, { ns: "flags" })
    : valueType === "string"
      ? i18n.t(($) => $.value.expectedString, { ns: "flags" })
      : i18n.t(($) => $.value.expectedNumber, { ns: "flags" });
};

/**
 * Edits a JSON-encoded flag value: true/false toggle, text, number, or a JSON document with live
 * validation. `value` and `onChange` are always JSON (e.g. `"blue"` with quotes for strings)
 */
export function ValueInput({
  valueType,
  value,
  onChange,
  label,
  isDisabled,
}: {
  valueType: FeatureValueType;
  value: string;
  onChange: (json: string) => void;
  label?: string;
  isDisabled?: boolean;
}) {
  const { t } = useTranslation("flags");
  const error = valueIssue(valueType, value);

  if (valueType === "boolean") {
    const parsed = parse(value);
    return (
      <div className="flex flex-col gap-1.5">
        {label !== undefined && <Label>{label}</Label>}
        <Segmented
          aria-label={label ?? t(($) => $.value.label)}
          value={parsed === true ? "true" : parsed === false ? "false" : ("" as "true")}
          onChange={(v) => onChange(v)}
          isDisabled={isDisabled}
          className="w-fit font-mono"
          options={[
            { id: "true", label: <span className="font-mono">true</span>, textValue: "true" },
            { id: "false", label: <span className="font-mono">false</span>, textValue: "false" },
          ]}
        />
      </div>
    );
  }

  if (valueType === "string") {
    const parsed = parse(value);
    return (
      <TextField
        aria-label={label === undefined ? t(($) => $.value.label) : undefined}
        value={typeof parsed === "string" ? parsed : ""}
        onChange={(text) => onChange(JSON.stringify(text))}
        isDisabled={isDisabled}
      >
        {label !== undefined && <Label>{label}</Label>}
        <Input className="font-mono text-base sm:text-label" placeholder={t(($) => $.value.emptyString)} />
      </TextField>
    );
  }

  if (valueType === "number") {
    const parsed = parse(value);
    return (
      <NumberField
        aria-label={label === undefined ? t(($) => $.value.label) : undefined}
        value={typeof parsed === "number" ? parsed : Number.NaN}
        onChange={(n) => onChange(Number.isFinite(n) ? String(n) : "")}
        formatOptions={{ useGrouping: false, maximumFractionDigits: 10 }}
        isDisabled={isDisabled}
        isInvalid={error !== null}
      >
        {label !== undefined && <Label>{label}</Label>}
        <NumberField.Group className="w-48">
          <NumberField.DecrementButton />
          <NumberField.Input className="font-mono text-base sm:text-label tabular" />
          <NumberField.IncrementButton />
        </NumberField.Group>
        {error !== null && <p className="text-meta text-danger">{t(($) => $.value.enterNumber)}</p>}
      </NumberField>
    );
  }

  const parsed = error === null ? parse(value) : undefined;
  const pretty = parsed === undefined ? null : JSON.stringify(parsed, null, 2);
  return (
    <TextField
      aria-label={label === undefined ? t(($) => $.value.label) : undefined}
      value={value}
      onChange={onChange}
      isInvalid={error !== null}
      isDisabled={isDisabled}
      className="w-full"
    >
      <div className="flex items-end justify-between gap-2">
        {label !== undefined ? <Label>{label}</Label> : <span />}
        {pretty !== null && pretty !== value && (
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-meta text-muted" onPress={() => onChange(pretty)} isDisabled={isDisabled}>
            {t(($) => $.value.format)}
          </Button>
        )}
      </div>
      <TextArea
        rows={Math.min(14, Math.max(4, value.split("\n").length + 1))}
        spellCheck={false}
        className="w-full resize-y font-mono text-base sm:text-label leading-5"
        placeholder='{ "variant": "a" }'
      />
      <p className={`text-meta ${error === null ? "text-muted" : "text-danger"}`} aria-live="polite">
        {error ?? t(($) => $.value.validJson)}
      </p>
    </TextField>
  );
}

const MAX_PREVIEW = 48;

/** One-line monospace rendering of a JSON-encoded value: true, "blue", 3, {"a":1}… (full value on hover) */
export function ValuePreview({ valueType, value, className = "" }: { valueType: FeatureValueType; value: string; className?: string }) {
  const parsed = parse(value);
  const full =
    parsed === undefined ? value : valueType === "json" ? JSON.stringify(parsed) : valueType === "string" ? JSON.stringify(parsed) : String(parsed);
  const text = full.length > MAX_PREVIEW ? `${full.slice(0, MAX_PREVIEW - 1)}…` : full;
  return (
    <code
      title={full.length > MAX_PREVIEW ? full : undefined}
      className={`inline-block max-w-full truncate rounded-[5px] bg-default px-1.5 py-0.5 align-middle font-mono text-label leading-5 ${className}`}
    >
      {text === "" ? '""' : text}
    </code>
  );
}
