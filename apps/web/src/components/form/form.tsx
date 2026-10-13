/**
 * TanStack Form bound to HeroUI fields. Every form in the app uses `useAppForm`:
 *
 *   const form = useAppForm({ defaultValues, onSubmit: async ({ value, formApi }) => { ... } });
 *   <form onSubmit={submitHandler(form)}>
 *     <form.AppField name="key" validators={{ onChange: matches(Key, () => t("keyInvalid")) }}>
 *       {(field) => <field.TextField label={t("key")} mono />}
 *     </form.AppField>
 *     <form.AppForm><form.FormError /><form.SubmitButton label={t("create")} /></form.AppForm>
 *   </form>
 *
 * Server errors: `setServerError(form, error, "key")` puts the API message under that field;
 * without a field name it becomes the form-level error shown by <form.FormError />
 */
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  NumberField as HeroNumberField,
  Select,
  Switch,
  TextArea,
  TextField as HeroTextField,
} from "@heroui/react";
import { type AnyFieldApi, type AnyFormApi, createFormHook, createFormHookContexts } from "@tanstack/react-form";
import { Schema } from "effect";
import { type FormEvent, type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "~/i18n";
import { errorMessage } from "~/lib/rpc";

export const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

/** Validator messages may be strings or Standard Schema issues */
export const errorText = (errors: ReadonlyArray<unknown>): string =>
  errors
    .map((e) => (typeof e === "string" ? e : typeof e === "object" && e !== null && "message" in e ? String(e.message) : ""))
    .filter((m) => m.length > 0)
    .join(" ");

/** Errors are shown once the user has left the field, or after a submit attempt */
const visibleError = (field: AnyFieldApi): string | null => {
  const { meta } = field.state;
  const submitted = field.form.state.submissionAttempts > 0;
  if (meta.errors.length === 0 || (!meta.isBlurred && !submitted)) return null;
  return errorText(meta.errors) || null;
};

/**
 * Validators return messages in the language active when they ran; re-run them when the user
 * switches language so a visible error follows the new language
 */
const useRevalidateOnLanguageChange = (field: AnyFieldApi) => {
  useEffect(() => {
    const revalidate = () => {
      if (field.state.meta.errors.length === 0) return;
      void field.validate("change");
      void field.validate("blur");
    };
    i18n.on("languageChanged", revalidate);
    return () => i18n.off("languageChanged", revalidate);
  }, [field]);
};

interface CommonProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly isDisabled?: boolean;
  readonly isReadOnly?: boolean;
  readonly className?: string;
}

function TextField({
  label,
  description,
  placeholder,
  type = "text",
  autoComplete,
  mono = false,
  isDisabled,
  isReadOnly,
  className,
}: CommonProps & {
  readonly placeholder?: string;
  readonly type?: "text" | "email" | "password" | "url";
  readonly autoComplete?: string;
  readonly mono?: boolean;
}) {
  const field = useFieldContext<string>();
  useRevalidateOnLanguageChange(field);
  const error = visibleError(field);
  return (
    <HeroTextField
      name={field.name}
      type={type}
      value={field.state.value}
      onChange={field.handleChange}
      onBlur={field.handleBlur}
      isInvalid={error !== null}
      isDisabled={isDisabled}
      isReadOnly={isReadOnly}
      autoComplete={autoComplete}
      validationBehavior="aria"
      className={className}
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} className={mono ? "font-mono" : undefined} />
      {description !== undefined && <Description>{description}</Description>}
      <FieldError>{error}</FieldError>
    </HeroTextField>
  );
}

function TextAreaField({
  label,
  description,
  placeholder,
  rows = 3,
  mono = false,
  isDisabled,
  isReadOnly,
  className,
}: CommonProps & { readonly placeholder?: string; readonly rows?: number; readonly mono?: boolean }) {
  const field = useFieldContext<string>();
  useRevalidateOnLanguageChange(field);
  const error = visibleError(field);
  return (
    <HeroTextField
      name={field.name}
      value={field.state.value}
      onChange={field.handleChange}
      onBlur={field.handleBlur}
      isInvalid={error !== null}
      isDisabled={isDisabled}
      isReadOnly={isReadOnly}
      validationBehavior="aria"
      className={className}
    >
      <Label>{label}</Label>
      <TextArea rows={rows} placeholder={placeholder} className={mono ? "font-mono text-label" : undefined} />
      {description !== undefined && <Description>{description}</Description>}
      <FieldError>{error}</FieldError>
    </HeroTextField>
  );
}

function NumberField({
  label,
  description,
  minValue,
  maxValue,
  step,
  formatOptions,
  suffix,
  isDisabled,
  isReadOnly,
  className,
}: CommonProps & {
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly step?: number;
  readonly formatOptions?: Intl.NumberFormatOptions;
  /** Unit shown after the input, e.g. "hours" */
  readonly suffix?: ReactNode;
}) {
  const field = useFieldContext<number>();
  useRevalidateOnLanguageChange(field);
  const error = visibleError(field);
  return (
    <HeroNumberField
      name={field.name}
      value={field.state.value}
      onChange={field.handleChange}
      onBlur={field.handleBlur}
      isInvalid={error !== null}
      isDisabled={isDisabled}
      isReadOnly={isReadOnly}
      minValue={minValue}
      maxValue={maxValue}
      step={step}
      formatOptions={formatOptions}
      validationBehavior="aria"
      className={className}
    >
      <Label>{label}</Label>
      <HeroNumberField.Group className={suffix === undefined ? undefined : "grid-cols-[1fr_auto]"}>
        <HeroNumberField.Input className="tabular" />
        {suffix !== undefined && <span className="pe-3 text-label text-muted">{suffix}</span>}
      </HeroNumberField.Group>
      {description !== undefined && <Description>{description}</Description>}
      <FieldError>{error}</FieldError>
    </HeroNumberField>
  );
}

export interface SelectOption {
  readonly id: string;
  readonly label: ReactNode;
  /** Plain text used for typeahead and accessibility */
  readonly textValue: string;
}

function SelectField({
  label,
  description,
  options,
  placeholder,
  isDisabled,
  className,
}: CommonProps & { readonly options: ReadonlyArray<SelectOption>; readonly placeholder?: string }) {
  const field = useFieldContext<string>();
  useRevalidateOnLanguageChange(field);
  const error = visibleError(field);
  return (
    <Select
      name={field.name}
      value={field.state.value === "" ? null : field.state.value}
      onChange={(key) => field.handleChange(key === null ? "" : String(key))}
      onBlur={field.handleBlur}
      isInvalid={error !== null}
      isDisabled={isDisabled}
      placeholder={placeholder}
      validationBehavior="aria"
      className={className}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {description !== undefined && <Description>{description}</Description>}
      <FieldError>{error}</FieldError>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.textValue}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function SwitchField({ label, description, isDisabled, className }: CommonProps) {
  const field = useFieldContext<boolean>();
  return (
    <div className={`flex items-start justify-between gap-4 ${className ?? ""}`}>
      <div className="min-w-0">
        <p className="text-label font-medium">{label}</p>
        {description !== undefined && <p className="mt-0.5 text-label text-muted">{description}</p>}
      </div>
      <Switch
        size="sm"
        name={field.name}
        isSelected={field.state.value}
        onChange={field.handleChange}
        isDisabled={isDisabled}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}

/** Disabled while submitting; shows the pending state on the button itself */
function SubmitButton({
  label,
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: {
  readonly label: ReactNode;
  readonly variant?: "primary" | "secondary" | "outline";
  readonly size?: "sm" | "md";
  readonly fullWidth?: boolean;
  readonly className?: string;
}) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(s) => s.isSubmitting}>
      {(isSubmitting) => (
        <Button type="submit" variant={variant} size={size} fullWidth={fullWidth} isPending={isSubmitting} className={className}>
          {label}
        </Button>
      )}
    </form.Subscribe>
  );
}

/** Form-level error, e.g. a server message that belongs to no single field */
function FormError({ className = "" }: { readonly className?: string }) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(s) => s.errorMap.onServer ?? s.errorMap.onSubmit}>
      {(error) => {
        const text = error === undefined || error === null ? "" : errorText([error]);
        return text === "" ? null : (
          <p role="alert" className={`rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger ${className}`}>
            {text}
          </p>
        );
      }}
    </form.Subscribe>
  );
}

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, TextAreaField, NumberField, SelectField, SwitchField },
  formComponents: { SubmitButton, FormError },
});

/** `<form onSubmit={submitHandler(form)}>` */
export const submitHandler = (form: Pick<AnyFormApi, "handleSubmit">) => (e: FormEvent) => {
  e.preventDefault();
  e.stopPropagation();
  void form.handleSubmit();
};

/**
 * Field validator from an Effect Schema (e.g. the contract's `Key`): the schema decides validity,
 * the caller supplies the message in the current language
 */
export const matches =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, message: () => string) =>
  ({ value }: { value: unknown }): string | undefined =>
    Schema.is(schema)(value) ? undefined : message();

/**
 * Shows an API error under `field`, or as the form-level error when no field is given.
 * Stored as the `onServer` error, which the next submit clears, so the user can always retry
 */
export const setServerError = (form: AnyFormApi, error: unknown, field?: string): void => {
  const message = typeof error === "string" ? error : errorMessage(error);
  if (field === undefined) {
    form.setErrorMap({ onServer: { form: message, fields: {} } });
    return;
  }
  form.setErrorMap({ onServer: { fields: { [field]: message } } });
  // A field's server error describes the value that was sent; drop it as soon as the user edits it
  const sent = form.getFieldValue(field);
  const subscription = form.store.subscribe(() => {
    if (Object.is(form.getFieldValue(field), sent)) return;
    subscription.unsubscribe();
    form.setFieldMeta(field, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: undefined } }));
  });
};

/** Required-text validator with a localized message */
export function useRequired() {
  const { t } = useTranslation();
  return ({ value }: { value: string }) => (value.trim().length === 0 ? t("form.required") : undefined);
}
