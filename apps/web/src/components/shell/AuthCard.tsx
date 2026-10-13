import { Button, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <LogoMark className="mb-6 size-9" />
        <h1 className="text-title font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-body text-muted">{description}</p>
        <Form
          className="mt-8 flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const values = { name: "", email: "", password: "" };
            for (const f of fields) values[f.name] = String(data.get(f.name) ?? "");
            setPending(true);
            setError(await onSubmit(values));
            setPending(false);
          }}
        >
          {fields.map((f) => (
            <TextField
              key={f.name}
              name={f.name}
              type={f.type ?? "text"}
              isRequired
              isReadOnly={f.isReadOnly}
              defaultValue={f.defaultValue}
              minLength={f.minLength}
              autoComplete={f.autoComplete}
            >
              <Label>{f.label}</Label>
              <Input />
              <FieldError />
            </TextField>
          ))}
          {error !== null && (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-label text-danger">
              {error}
            </p>
          )}
          <Button type="submit" fullWidth isPending={pending} className="mt-2">
            {submitLabel}
          </Button>
        </Form>
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
