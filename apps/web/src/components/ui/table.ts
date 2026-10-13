/**
 * Class names for plain list tables: 13px rows, hairline separators, a header in meta type.
 * A row becomes one click target by giving its primary link `rowLink` (stretched over the `tr`);
 * other controls in the row add `relative z-1` to stay clickable
 */
export const tbl = {
  table: "w-full border-collapse text-label",
  th: "h-9 whitespace-nowrap border-b border-border px-3 text-left text-meta font-medium text-muted first:pl-4 last:pr-4 sm:px-4 sm:first:pl-5 sm:last:pr-5",
  tr: "relative border-b border-border transition-colors duration-150 ease-out-quart last:border-b-0 hover:bg-default/40",
  td: "h-12 px-3 align-middle first:pl-4 last:pr-4 sm:px-4 sm:first:pl-5 sm:last:pr-5",
  num: "text-right font-mono tabular",
  rowLink:
    "rounded-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus",
} as const;
