import { Button, Skeleton, Tooltip } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { intlLocale } from "~/i18n";

/** Page title row: title + one-line description on the left, primary actions on the right */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1 pb-6">
      {breadcrumb}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-title font-semibold tracking-tight">{title}</h1>
          {description !== undefined && <p className="mt-1 max-w-[70ch] text-body text-muted">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Teaches the next step instead of saying "nothing here" */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-border px-6 py-14 text-center">
      {icon !== undefined && (
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-muted [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="flex max-w-[48ch] flex-col gap-1">
        <h2 className="text-section font-medium">{title}</h2>
        <p className="text-body text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Monospace token (flag key, SDK key, value) with an optional copy button */
export function Code({ children, copy = false, className = "" }: { children: string; copy?: boolean; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      <code className="truncate rounded-[5px] bg-default px-1.5 py-0.5 font-mono text-[0.8125rem]">{children}</code>
      {copy && <CopyButton value={children} />}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const name = label ?? t("actions.copy");
  return (
    <Tooltip delay={300}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={name}
        className="size-7 min-w-7 text-muted"
        onPress={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5 text-win" /> : <Copy className="size-3.5" />}
      </Button>
      <Tooltip.Content>{copied ? t("actions.copied") : name}</Tooltip.Content>
    </Tooltip>
  );
}

/** Bordered panel, the default container for grouped content (never nest these) */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[10px] border border-border bg-surface ${className}`}>{children}</section>;
}

export function PanelHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-section font-medium">{title}</h2>
        {description !== undefined && <p className="mt-0.5 text-label text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Skeleton rows for tables and lists while loading */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 p-5" aria-busy="true" aria-label={t("states.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5 rounded-md" style={{ width: `${85 - ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}

/** Inline error with retry, for failed queries */
export function QueryError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center justify-between gap-4 rounded-[10px] border border-danger/30 bg-danger/5 px-4 py-3 text-body">
      <span>{message}</span>
      {onRetry !== undefined && (
        <Button size="sm" variant="outline" onPress={onRetry}>
          {t("actions.retry")}
        </Button>
      )}
    </div>
  );
}

const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 hours ago" with the exact timestamp in a tooltip */
export function RelativeTime({ date }: { date: Date | string }) {
  const { t } = useTranslation();
  const d = typeof date === "string" ? new Date(date) : date;
  const relativeFormat = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  const seconds = (d.getTime() - Date.now()) / 1000;
  const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) ?? ["second", 1];
  const text = Math.abs(seconds) < 45 ? t("states.justNow") : relativeFormat.format(Math.round(seconds / size), unit);
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString(intlLocale())} className="whitespace-nowrap">
      {text}
    </time>
  );
}
