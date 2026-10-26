import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { setServerError, submitHandler, useAppForm } from "~/components/form/form";
import { currentLocale, setLocale } from "~/i18n";
import { LogoMark } from "./Logo";

export interface AuthField {
  readonly name: "name" | "email" | "password";
  readonly label: string;
  readonly type?: "email" | "password" | "text";
  readonly autoComplete: string;
  readonly defaultValue?: string;
  readonly isReadOnly?: boolean;
  readonly minLength?: number;
  /** Shown under the field from the start, e.g. the password rule */
  readonly description?: string;
}

/** Centered sign-in / sign-up card used by /login and /invite */
export function AuthCard({
  title,
  description,
  fields,
  submitLabel,
  onSubmit,
  footer,
}: {
  title: string;
  description: ReactNode;
  fields: ReadonlyArray<AuthField>;
  submitLabel: string;
  onSubmit: (values: Record<AuthField["name"], string>) => Promise<string | null>;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const form = useAppForm({
    defaultValues: {
      name: fields.find((f) => f.name === "name")?.defaultValue ?? "",
      email: fields.find((f) => f.name === "email")?.defaultValue ?? "",
      password: "",
    },
    onSubmit: async ({ value, formApi }) => {
      const error = await onSubmit(value);
      if (error !== null) setServerError(formApi, error);
    },
  });
  const validatorFor = (f: AuthField) => ({
    onBlur: ({ value }: { value: string }) => {
      if (value.trim().length === 0) return t(($) => $.form.required);
      if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return t(($) => $.form.email);
      if (f.minLength !== undefined && value.length < f.minLength) return t(($) => $.form.minLength, { count: f.minLength });
      return undefined;
    },
  });
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <LogoMark className="mb-6 size-9" />
        <h1 className="text-title font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-body text-muted">{description}</p>
        <form className="mt-8 flex flex-col gap-4" noValidate onSubmit={submitHandler(form)}>
          {fields.map((f) => (
            <form.AppField key={f.name} name={f.name} validators={validatorFor(f)}>
              {(field) => (
                <field.TextField
                  label={f.label}
                  type={f.type ?? "text"}
                  autoComplete={f.autoComplete}
                  isReadOnly={f.isReadOnly}
                  description={f.description}
                />
              )}
            </form.AppField>
          ))}
          <form.AppForm>
            <form.FormError />
            <form.SubmitButton label={submitLabel} fullWidth className="mt-2" />
          </form.AppForm>
        </form>
        {footer !== undefined && <div className="mt-6 text-label text-muted">{footer}</div>}
        <LanguageToggle />
      </div>
    </div>
  );
}

/** Language choice before sign-in (inside the app it lives in the account menu) */
function LanguageToggle() {
  useTranslation();
  const locale = currentLocale();
  const option = (value: "en" | "ja", label: string) => (
    <button
      type="button"
      lang={value}
      aria-pressed={locale === value}
      onClick={() => setLocale(value)}
      className={`rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${locale === value ? "text-foreground" : "hover:text-foreground"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="mt-10 flex gap-3 text-meta text-muted">
      {option("en", "English")}
      <span aria-hidden="true">·</span>
      {option("ja", "日本語")}
    </div>
  );
}
