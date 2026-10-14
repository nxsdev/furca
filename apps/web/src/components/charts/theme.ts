/**
 * Host classes for interactive charts. Guides inherit `currentColor` (muted text token, so light/dark follow
 * the app theme); the built-in tooltip reads its chrome from these overlay tokens.
 */
export const chartHostClass = [
  "text-muted tabular text-[11px] [&_svg]:rounded-md",
  "[--ts-chart-tooltip-background:var(--overlay)] [--ts-chart-tooltip-color:var(--overlay-foreground)]",
  "[--ts-chart-tooltip-border:0] [--ts-chart-tooltip-shadow:var(--overlay-shadow)] [--ts-chart-tooltip-border-radius:6px]",
  "[--ts-chart-tooltip-padding:8px_10px] [--ts-chart-tooltip-font:400_12px/1.4_var(--font-sans)]",
  "[--ts-chart-tooltip-active-row-font-weight:500] [--ts-chart-tooltip-active-row-background:transparent] [--ts-chart-tooltip-active-row-shadow:none]",
].join(" ");
