import type { AuditLog } from "@furca/core/audit/AuditLog";
import { Button } from "@heroui/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight, History } from "lucide-react";
import { useState } from "react";
import { EmptyState, ListSkeleton, Panel, QueryError, RelativeTime } from "~/components/ui/primitives";
import { useEnvironment } from "~/lib/environment";
import { errorMessage, orpc } from "~/lib/rpc";

const PAGE = 50;

const verbs: Record<string, string> = {
  created: "created the flag",
  updated: "updated the flag",
  "rules.updated": "changed rules",
  enabled: "turned the flag on",
  disabled: "turned the flag off",
  archived: "archived the flag",
  unarchived: "restored the flag",
  deleted: "deleted the flag",
};
const verb = (action: string) => verbs[action] ?? action.replace(/[._]/g, " ");

const IGNORED = new Set(["updatedAt", "createdAt"]);

const parse = (json: string | null): unknown => {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/** Drops timestamps and keys environments by their key ("production") instead of position */
function normalize(snapshot: unknown, names: ReadonlyMap<string, string>): unknown {
  if (!isObject(snapshot) || Array.isArray(snapshot)) return snapshot;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (IGNORED.has(k)) continue;
    if (k === "environments" && Array.isArray(v) && v.every((e) => isObject(e) && typeof e.environmentId === "string")) {
      for (const { environmentId, ...rest } of v as Array<Record<string, unknown>>) out[names.get(String(environmentId)) ?? String(environmentId)] = rest;
    } else out[k] = v;
  }
  return out;
}

interface Change {
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

/** Smallest changed subtrees: recurses while both sides are objects, otherwise reports the whole value */
function diff(a: unknown, b: unknown, path: string, out: Array<Change>): Array<Change> {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) diff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : path === "" ? k : `${path}.${k}`, out);
    return out;
  }
  out.push({
    path: path === "" ? "(value)" : path,
    before: a === undefined ? undefined : JSON.stringify(a),
    after: b === undefined ? undefined : JSON.stringify(b),
  });
  return out;
}

const changes = (entry: AuditLog, names: ReadonlyMap<string, string>) =>
  diff(normalize(parse(entry.before), names) ?? {}, normalize(parse(entry.after), names) ?? {}, "", []);

/** Compact audit timeline for one flag, newest first, with an expandable field-level diff */
export function HistoryPanel({ featureId }: { featureId: string }) {
  const { environments } = useEnvironment();
  const names = new Map(environments.map((e) => [e.id, e.key]));
  const query = useInfiniteQuery(
    orpc.audit.list.infiniteOptions({
      input: (before: Date | null) => ({ entityType: "feature", entityId: featureId, before, limit: PAGE }),
      initialPageParam: null,
      getNextPageParam: (last) => (last.length === PAGE ? (last.at(-1)?.createdAt ?? null) : null),
    }),
  );
  const entries = query.data?.pages.flat() ?? [];

  if (query.error !== null) {
    return <QueryError message={`Could not load history. ${errorMessage(query.error)}`} onRetry={() => query.refetch()} />;
  }
  if (query.isPending) {
    return (
      <Panel>
        <ListSkeleton rows={5} />
      </Panel>
    );
  }
  if (entries.length === 0) {
    return <EmptyState icon={<History />} title="No changes recorded" description="Every change to this flag (rules, switches, values) is logged here with who made it." />;
  }
  return (
    <Panel>
      <ol className="px-4 py-2 sm:px-5">
        {entries.map((entry, i) => (
          <HistoryItem key={entry.id} entry={entry} names={names} isLast={i === entries.length - 1} />
        ))}
      </ol>
      {query.hasNextPage && (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          <Button size="sm" variant="ghost" isPending={query.isFetchingNextPage} onPress={() => query.fetchNextPage()}>
            Load older changes
          </Button>
        </div>
      )}
    </Panel>
  );
}

function HistoryItem({ entry, names, isLast }: { entry: AuditLog; names: ReadonlyMap<string, string>; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const diff = open ? changes(entry, names) : [];
  const hasSnapshot = entry.before !== null || entry.after !== null;
  return (
    <li className="relative py-2.5 pl-6">
      <span className="absolute top-[17px] left-[3px] size-[7px] rounded-full bg-muted/60" aria-hidden="true" />
      {!isLast && <span className="absolute top-7 bottom-[-10px] left-[6px] w-px bg-border" aria-hidden="true" />}
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-label">
        <span className="font-medium">{entry.actorEmail}</span>
        <span className="text-muted">{verb(entry.action)}</span>
        <span className="ml-auto pl-2 text-meta text-muted">
          <RelativeTime date={entry.createdAt} />
        </span>
      </div>
      {hasSnapshot && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 -ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-meta text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden="true" />
          {open ? "Hide changes" : "Show changes"}
        </button>
      )}
      {open && (
        <div className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-secondary">
          {diff.length === 0 ? (
            <p className="px-3 py-2 text-meta text-muted">No field-level differences.</p>
          ) : (
            <table className="w-full font-mono text-meta">
              <tbody>
                {diff.map((d) => (
                  <tr key={d.path} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5 align-top whitespace-nowrap text-muted">{d.path}</td>
                    <td className="px-3 py-1.5 align-top break-all">
                      {d.before !== undefined && <span className="text-muted line-through decoration-muted/60">{d.before}</span>}
                      {d.before !== undefined && d.after !== undefined && <span className="px-1.5 text-muted">→</span>}
                      {d.after !== undefined && <span>{d.after}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  );
}
