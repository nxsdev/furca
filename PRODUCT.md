# Product

## Register

product

## Users

Product engineers and PMs on small-to-mid teams who self-host kuji on their own Cloudflare account.
Engineers flip between their editor and kuji to create a flag, target QA users, or ship a winning
variation; PMs open an experiment page (often on a shared screen in a review meeting) to decide
whether yesterday's result is real. Both are fluent in Vercel, Linear, Stripe and GitHub.

## Product Purpose

Feature flags and A/B experiments whose results can be trusted, deployable to Cloudflare Workers
with nothing else to run. Success = a team registers a hypothesis, ships it behind a flag, and makes
a correct ship / rollback decision without a statistician in the room.

## Brand Personality

Precise, calm, honest. Like a good instrument: quiet until it has something true to say, then says
it plainly ("Not enough data yet", "Sample ratio mismatch: results are not trustworthy").

## Anti-references

- GrowthBook's dense, toggle-sprawled results page and two-place flag/experiment editing
- Marketing-dashboard aesthetics: hero metrics, gradient accents, glass cards
- Green/red everywhere: color must keep its statistical meaning

## Design Principles

1. Decision first: every experiment page leads with the answer and how sure we are, then the evidence.
2. Color is semantic: green = winning, red = losing, amber = data health warning. Never decoration.
3. One object, one place: an experiment owns its flag rule; nothing is edited in two places.
4. Keyboard-fast: command palette, copyable keys, no modal when inline works.
5. Honest emptiness: empty and low-data states explain what to do next.

## Accessibility & Inclusion

WCAG 2.2 AA. Status never conveyed by color alone (icon + label). Visible focus rings. Reduced
motion respected. Charts have text equivalents (tables beside plots).
