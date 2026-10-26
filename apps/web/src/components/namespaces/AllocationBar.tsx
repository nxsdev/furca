import type { NamespaceListItem } from "@furca/api/contract";
import { useTranslation } from "react-i18next";
import type { Slice } from "./allocation";

type Allocation = NamespaceListItem["allocations"][number];

/** 0.25 -> "25%", 0.125 -> "12.5%" */
export const percentLabel = (x: number) => `${Number((x * 100).toFixed(1))}%`;
export const rangeLabel = (s: Slice) => `${percentLabel(s.start)}–${percentLabel(s.end)}`;

/**
 * 0–100% of a namespace with each experiment's slice. Running slices are solid, drafts dashed
 * (status is never color alone); `selection` outlines the slice being edited
 */
export function AllocationBar({
  allocations,
  selection = null,
  conflict = false,
}: {
  allocations: ReadonlyArray<Allocation>;
  selection?: Slice | null;
  /** Draws the selection as an error (it overlaps a running experiment) */
  conflict?: boolean;
}) {
  const { t } = useTranslation("namespaces");
  const pos = (s: Slice) => ({ left: `${s.start * 100}%`, width: `${(s.end - s.start) * 100}%` });
  const describe = (a: Allocation) => `${a.experimentName} · ${t(($) => $.status[a.status])} · ${rangeLabel(a)}`;
  const summary = allocations.length === 0 ? t(($) => $.bar.empty) : allocations.map(describe).join("; ");
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={summary} className="relative h-7 overflow-hidden rounded-md border border-border bg-default/40">
        {/* Running slices paint over drafts, so an overlap never hides what is live */}
        {[...allocations].sort((x, y) => Number(x.status === "running") - Number(y.status === "running")).map((a) => (
          <div
            key={a.experimentId}
            title={describe(a)}
            style={pos(a)}
            className={`absolute inset-y-0 flex items-center overflow-hidden px-1.5 text-meta ${
              a.status === "running"
                ? "bg-focus/20 text-foreground shadow-[inset_0_0_0_1px_var(--focus)]"
                : "border border-dashed border-muted/70 bg-surface text-muted"
            }`}
          >
            {a.end - a.start >= 0.12 && <span className="truncate">{a.experimentName}</span>}
          </div>
        ))}
        {selection !== null && selection.end > selection.start && (
          <div
            aria-hidden="true"
            style={pos(selection)}
            className={`absolute inset-y-0 rounded-[3px] ${conflict ? "bg-danger/15 shadow-[inset_0_0_0_2px_var(--danger)]" : "bg-foreground/10 shadow-[inset_0_0_0_2px_var(--foreground)]"}`}
          />
        )}
      </div>
      <div aria-hidden="true" className="flex justify-between font-mono text-[11px] text-muted tabular">
        <span>0%</span>
        <span>25%</span>
        <span>50%</span>
        <span>75%</span>
        <span>100%</span>
      </div>
    </div>
  );
}
