# Design

Scene: an engineer at a desk mid-afternoon, editor in dark mode on one side, kuji on the other; or a
PM projecting the results page in a bright meeting room. Both themes are first-class; default follows
the OS.

## Color (OKLCH, restrained)

Ink-on-paper monochrome like Geist. Primary actions are ink (black in light, white in dark). One
interaction accent (blue) for focus rings, links and selection. Semantic colors are reserved for
meaning and never used decoratively.

| Role | Light | Dark | Use |
|---|---|---|---|
| background | oklch(0.985 0 0) | oklch(0.13 0 0) | app canvas |
| surface | oklch(1 0 0) | oklch(0.17 0 0) | panels, tables |
| surface-secondary | oklch(0.97 0 0) | oklch(0.2 0 0) | sidebar, hovers |
| foreground | oklch(0.21 0 0) | oklch(0.95 0 0) | text |
| muted | oklch(0.49 0 0) | oklch(0.72 0 0) | secondary text (≥4.5:1) |
| border | oklch(0.92 0 0) | oklch(0.27 0 0) | hairlines |
| accent (primary button) | ink | ink | primary CTA |
| focus / link | oklch(0.55 0.2 255) | oklch(0.68 0.17 255) | focus ring, links, selection |
| success (winning) | oklch(0.55 0.15 150) | oklch(0.72 0.17 150) | significant improvement |
| danger (losing) | oklch(0.58 0.2 25) | oklch(0.68 0.19 25) | significant regression, destructive |
| warning (health) | oklch(0.72 0.15 75) | oklch(0.8 0.14 75) | SRM, multiple exposures |
| brand mark | oklch(0.57 0.16 353) | same | logo tip only (omikuji stick) |

Variation colors in charts: control = muted gray; treatments = blue 255, violet 300, teal 190,
amber 75 (in that order). Lift intervals use the verdict color, not the variation color.

## Typography

Geist Sans for everything, Geist Mono for keys, values, SDK keys, code and numbers in tables
(`font-variant-numeric: tabular-nums`). Fixed rem scale, ratio ~1.15:
12 (meta) / 13 (table, labels) / 14 (body) / 16 (section title) / 20 (page title) / 24 (hero number
in results only). Weights 400 / 500 / 600. Page titles use `text-wrap: balance`.

## Layout

App shell: 240px sidebar (collapsible to 56px) on surface-secondary, content max 1200px with 32px
gutters, page header (title + one-line description + primary action right-aligned). Lists are tables,
not cards. Detail pages: header, tabs, then content. Radius 6px for controls, 10px for panels.

## Components

HeroUI v3 with overrides: buttons 6px radius (not pills), fields with 1px border, surfaces drawn with
a 1px border-as-shadow. Every interactive element has hover, focus-visible, active, disabled and
pending states. Skeletons for loading. Empty states explain the next step with one action.

## Motion

150–200ms ease-out-quart for state changes (hover, toggle, expand). No page-load choreography.
`prefers-reduced-motion` turns transitions into instant changes.
