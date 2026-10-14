import { Button } from "@heroui/react";
import type { AuditEntityType, AuditLog } from "@furca/core/audit/AuditLog";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChartLine, ChevronRight, Database, Flag, FlaskConical, History, KeyRound, KeySquare, Layers, UserRound, UsersRound, Webhook } from "lucide-react";
import { type ComponentType, Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "~/components/results/format";
import { ListSkeleton, QueryError, RelativeTime } from "~/components/ui/primitives";
import { tbl } from "~/components/ui/table";
import { i18n } from "~/i18n";
import { errorMessage, orpc } from "~/lib/rpc";
import { diffLines, foldUnchanged, prettyLines } from "./diff";

/** Plural labels live under `audit:entityTypes.<type>` */
export const entityTypes: ReadonlyArray<{
  readonly type: AuditEntityType;
  readonly icon: ComponentType<{ className?: string }>;
}> = [
  { type: "feature", icon: Flag },
  { type: "experiment", icon: FlaskConical },
  { type: "metric", icon: ChartLine },
  { type: "datasource", icon: Database },
  { type: "environment", icon: KeyRound },
  { type: "member", icon: UserRound },
  { type: "savedGroup", icon: UsersRound },
  { type: "namespace", icon: Layers },
  { type: "apiKey", icon: KeySquare },
  { type: "webhook", icon: Webhook },
];

const snapshot = (json: string | null): Record<string, unknown> | null => {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Human name of the changed entity, taken from its snapshot (flags are known by key) */
const entityName = (entry: AuditLog): string => {
  const s = snapshot(entry.after) ?? snapshot(entry.before);
  const pick = (k: string) => (typeof s?.[k] === "string" && s[k] !== "" ? (s[k] as string) : null);
  return (entry.entityType === "feature" ? pick("key") : null) ?? pick("name") ?? pick("key") ?? pick("email") ?? entry.entityId;
};

/** Every action the server writes; each has a label under `audit:actions` */
const KNOWN_ACTIONS = [
  "created",
  "updated",
  "enabled",
  "disabled",
  "archived",
  "unarchived",
  "deleted",
  "started",
  "stopped",
  "invited",
  "removed",
  "rules.updated",
  "phase.started",
  "traffic.updated",
  "sdkKey.rotated",
  "credentials.updated",
  "invitation.revoked",
] as const;
const isKnownAction = (a: string): a is (typeof KNOWN_ACTIONS)[number] => (KNOWN_ACTIONS as ReadonlyArray<string>).includes(a);

/** Known verbs are translated; unknown ones are derived in English: "rules.updated" -> "updated rules" */
const actionLabel = (action: string): string =>
  isKnownAction(action)
    ? i18n.t(`audit:actions.${action}`)
    : action
        .split(".")
        .reverse()
        .join(" ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();

function EntityLink({ entry }: { entry: AuditLog }) {
  const meta = entityTypes.find((t) => t.type === entry.entityType);
  const Icon = meta?.icon ?? History;
  const name = entityName(entry);
  const label = (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      <span className={`truncate ${entry.entityType === "feature" ? "font-mono" : ""}`}>{name}</span>
    </span>
  );
  const linkCls = "relative z-1 inline-flex min-w-0 max-w-full rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus";
  if (entry.action === "deleted") return label;
  switch (entry.entityType) {
    case "feature":
      return (
        <Link to="/flags/$featureId" params={{ featureId: entry.entityId }} className={linkCls}>
          {label}
        </Link>
      );
    case "experiment":
      return (
        <Link to="/experiments/$experimentId" params={{ experimentId: entry.entityId }} className={linkCls}>
          {label}
        </Link>
      );
    case "metric":
      return (
        <Link to="/metrics/$metricId" params={{ metricId: entry.entityId }} className={linkCls}>
          {label}
        </Link>
      );
    case "datasource":
      return (
        <Link to="/data-sources/$dataSourceId" params={{ dataSourceId: entry.entityId }} className={linkCls}>
          {label}
        </Link>
      );
    case "environment":
      return (
        <Link to="/environments" className={linkCls}>
          {label}
        </Link>
      );
    case "member":
    case "apiKey":
    case "webhook":
      return (
        <Link to="/settings" className={linkCls}>
          {label}
        </Link>
      );
    case "savedGroup":
      return (
        <Link to="/saved-groups/$savedGroupId" params={{ savedGroupId: entry.entityId }} className={linkCls}>
          {label}
        </Link>
      );
    case "namespace":
      return (
        <Link to="/namespaces" className={linkCls}>
          {label}
        </Link>
      );
  }
}

/** Readable before/after: unchanged lines folded, additions and removals tinted subtly */
export function JsonDiff({ before, after, caption }: { before: string | null; after: string | null; caption?: string }) {
  const { t } = useTranslation("audit");
  const a = prettyLines(before);
  const b = prettyLines(after);
  const onlyOne = a.length === 0 || b.length === 0;
  const rows = onlyOne
    ? (a.length === 0 ? b : a).map((text) => ({ kind: "same" as const, text }))
    : foldUnchanged(diffLines(a, b));
  const changes = rows.filter((r) => r.kind === "add" || r.kind === "del").length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-meta text-muted">
        {onlyOne
          ? a.length === 0
            ? t("diff.createdWith")
            : t("diff.stateBefore")
          : changes === 0
            ? t("diff.noFieldChanged")
            : t("diff.changedLines", { count: changes })}
        {caption !== undefined && ` · ${caption}`}
      </p>
      <div className="max-h-[420px] overflow-auto rounded-md border border-border bg-background">
        <div className="w-max min-w-full py-1.5 font-mono text-[12px] leading-5">
          {rows.map((r, i) =>
            r.kind === "skip" ? (
              <div key={i} className="px-3 py-0.5 text-muted select-none">
                ⋯ {t("diff.unchangedLines", { count: r.count })}
              </div>
            ) : (
              <div
                key={i}
                className={`flex ${r.kind === "add" ? "bg-success/5" : r.kind === "del" ? "bg-danger/5" : ""}`}
              >
                <span
                  aria-hidden="true"
                  className={`w-7 shrink-0 select-none text-center ${r.kind === "add" ? "text-win" : r.kind === "del" ? "text-lose" : "text-muted/50"}`}
                >
                  {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                </span>
                <span className="sr-only">{r.kind === "add" ? t("diff.added") : r.kind === "del" ? t("diff.removed") : ""}</span>
                <span className="whitespace-pre pr-4">{r.text}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Audit timeline. Pages with a `before` cursor ("Load older"); each row expands to a diff.
 * `showEntity` is off on an entity's own History panel
 */
export function AuditList({
  entityType = null,
  entityId = null,
  limit = 50,
  paginate = true,
  showEntity = true,
  emptyDescription,
}: {
  entityType?: AuditEntityType | null;
  entityId?: string | null;
  limit?: number;
  paginate?: boolean;
  showEntity?: boolean;
  emptyDescription?: string;
}) {
  const { t } = useTranslation(["audit", "common"]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const query = useInfiniteQuery(
    orpc.audit.list.infiniteOptions({
      input: (before: Date | null) => ({ entityType, entityId, before, limit }),
      initialPageParam: null as Date | null,
      getNextPageParam: (last) => (last.length < limit ? undefined : (last.at(-1)?.createdAt ?? undefined)),
    }),
  );

  if (query.isPending) return <ListSkeleton rows={Math.min(limit, 6)} />;
  if (query.data === undefined)
    return (
      <div className="p-4">
        <QueryError message={t("list.loadFailed", { message: errorMessage(query.error) })} onRetry={() => query.refetch()} />
      </div>
    );

  const entries = query.data.pages.flat();
  if (entries.length === 0)
    return (
      <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
        <History className="mb-2 size-5 text-muted" aria-hidden="true" />
        <p className="text-body font-medium">{t("list.emptyTitle")}</p>
        <p className="max-w-[52ch] text-label text-muted">{emptyDescription ?? t("list.emptyDescription")}</p>
      </div>
    );

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <div className="overflow-x-auto">
        <table className={tbl.table}>
          <thead>
            <tr>
              <th className={`${tbl.th} w-8 pr-0`}>
                <span className="sr-only">{t("list.expand")}</span>
              </th>
              {showEntity && <th className={tbl.th}>{t("list.entity")}</th>}
              <th className={tbl.th}>{t("list.change")}</th>
              <th className={`${tbl.th} hidden md:table-cell`}>{t("list.by")}</th>
              <th className={`${tbl.th} hidden text-right sm:table-cell`}>{t("list.when")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const expandable = entry.before !== null || entry.after !== null;
              const isOpen = open.has(entry.id);
              return (
                <Fragment key={entry.id}>
                  <tr className={`${tbl.tr} ${isOpen ? "border-b-0 bg-default/30" : ""}`}>
                    <td className={`${tbl.td} w-8 pr-0`}>
                      {expandable && (
                        <button
                          type="button"
                          onClick={() => toggle(entry.id)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? t("list.hideDetails") : t("list.showDetails")}
                          className="flex size-6 items-center justify-center rounded-md text-muted outline-none transition-colors after:absolute after:inset-0 after:content-[''] hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <ChevronRight
                            className={`size-4 transition-transform duration-150 ease-out-quart ${isOpen ? "rotate-90" : ""}`}
                          />
                        </button>
                      )}
                    </td>
                    {showEntity && (
                      <td className={`${tbl.td} max-w-[280px]`}>
                        <EntityLink entry={entry} />
                      </td>
                    )}
                    <td className={tbl.td}>
                      <span className="whitespace-nowrap">{actionLabel(entry.action)}</span>
                      <span className="block text-meta text-muted sm:hidden">
                        <RelativeTime date={entry.createdAt} />
                      </span>
                    </td>
                    <td className={`${tbl.td} hidden max-w-[240px] truncate text-muted md:table-cell`}>{entry.actorEmail}</td>
                    <td className={`${tbl.td} hidden text-right text-muted sm:table-cell`}>
                      <RelativeTime date={entry.createdAt} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-border bg-default/30">
                      <td colSpan={showEntity ? 5 : 4} className="px-5 pb-4">
                        <JsonDiff
                          before={entry.before}
                          after={entry.after}
                          caption={t("list.caption", {
                            email: entry.actorEmail,
                            date: formatDateTime(new Date(entry.createdAt)),
                          })}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {paginate && query.hasNextPage && (
        <div className="flex justify-center border-t border-border p-3">
          <Button size="sm" variant="ghost" onPress={() => query.fetchNextPage()} isPending={query.isFetchingNextPage}>
            {t("common:actions.loadOlder")}
          </Button>
        </div>
      )}
      {paginate && query.isFetchNextPageError && (
        <div className="border-t border-border p-3">
          <QueryError message={errorMessage(query.error)} onRetry={() => query.fetchNextPage()} />
        </div>
      )}
    </div>
  );
}
