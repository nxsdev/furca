# furca — agent guide

Open-source feature flags + A/B testing that deploys to one Cloudflare Worker (D1 + KV), with an
optional BigQuery warehouse. Product scope and what we deliberately do NOT build:
[docs/product/feature-decisions.md](docs/product/feature-decisions.md). Design: [PRODUCT.md](PRODUCT.md),
[DESIGN.md](DESIGN.md).

Language: code, comments, UI copy and README in English. `docs/` is Japanese.

## Layout (dependency direction: apps → api → persistence → database/core; core depends on nothing)

```
apps/web               TanStack Start admin UI (HeroUI v3) + src/server.ts Worker entry (/api/* → @furca/api)
packages/core          Domain models (Effect Schema classes), errors, service contracts (Context.Service). No runtime code
packages/database      Drizzle schema (sqlite/D1), Database service, migrations/, Miniflare D1 test helper
packages/persistence   Repository / ServiceLive implementations (Layers/), row mappers (src/mappers.ts)
packages/integrations  External providers (BigQuery REST client)
packages/api           oRPC v2 contract (src/contract.ts), handlers (src/Handlers/*), SDK HTTP endpoints (src/Http), runtime
packages/stats         Pure statistics engine (no Effect; also bundled into the browser)
packages/sdk           Public zero-dependency SDK (@furca/sdk), local evaluation, GrowthBook-compatible hashing
packages/react         React bindings (@furca/react)
packages/openfeature   OpenFeature web + server providers (@furca/openfeature)
packages/infra         Alchemy v2 stack: Worker + D1 + KV
```

## Commands

Bun comes from mise: prefix shells with `export PATH=~/.local/share/mise/shims:$PATH`.

- Typecheck one package: `cd packages/<name> && ../../node_modules/.bin/tsc --noEmit -p .` (TypeScript 7 + Effect language service)
- Tests: `bun test packages/<name>` (from repo root)
- Published packages (sdk, react, openfeature) export `dist/`; the repo resolves `@furca/*` to `src` through `paths` in
  tsconfig.base.json. A tsconfig that sets its own `paths` must repeat those entries
- New migration after editing `packages/database/src/schema/*`: `cd packages/database && bunx drizzle-kit generate --name <what>`. Never edit an applied migration
- Route tree after adding routes: `cd apps/web && npx -y @tanstack/router-cli@1.167.5 generate`
- Dev server: `bun run dev` (Alchemy local D1/KV, http://localhost:5173). Demo data: `bun scripts/seed-demo.ts http://localhost:5173`.
  A parallel agent must use its own stage, port AND hostname (cookies ignore ports, so sessions collide on plain localhost):
  `ALCHEMY_LOCAL_STATE=1 ALCHEMY_STAGE=dev_<you> FURCA_DEV_PORT=<port> node_modules/.bin/alchemy dev packages/infra/alchemy.run.ts --no-input`,
  then open `http://<you>.localhost:<port>`. Stop only your own process (never `pkill -f` a shared command line)

## Effect 4 (stable 4.0.3)

- `import { Context, Effect, Layer, Schema } from "effect"`. Module paths are flat (`effect/Config`), not `effect/unstable/*`
- Services: `class X extends Context.Service<X, XShape>()("furca/X") {}`; shape interface named `XShape`
- Errors: `Schema.TaggedError` (not TaggedErrorClass). Domain errors live in `@furca/core/shared/errors`
- Public service methods: `Effect.fn("Service.method")(function* (...) { ... })`. Use `function*` only when you `yield*`
- Never swallow failures (`Effect.ignore`, `catch(() => void)`); log or map them
- Timestamps are `Date` (Schema.Date) end to end: DB `timestamp_ms` columns, domain, oRPC wire

## API: oRPC v2 (contract-first) + Effect

- The contract is `packages/api/src/contract.ts` (inputs: Effect Schema via `toStandardSchema`; outputs: `type<T>()`).
  Changing it changes the browser client too; keep it the single source of truth
- Handlers: `authed.<domain>.<proc>.effect(function* ({ context }, input) { ... })` in `packages/api/src/Handlers/<domain>.ts`.
  `context.user` is the signed-in user. Effect services come from `effect/context` (built per request from
  `makeAppLayer` in `Runtime/Services.ts`), so `yield* FeatureService` just works
- Outputs are converted to plain objects in `Runtime/orpc.ts` so Dates inside Schema.Class instances survive the wire
- Throw/fail with core domain errors (NotFoundError → NOT_FOUND, ValidationError → BAD_REQUEST, WarehouseError →
  BAD_GATEWAY); they are converted centrally in `Runtime/orpc.ts`. Use `new ORPCError("CONFLICT" | "FORBIDDEN", { message })`
  for API-only cases. Messages must be safe to show users
- Register new Effect layers in `Runtime/CoreServices.ts` (flags/experiments/metrics/datasources/environments/audit/members)
  or `Runtime/AnalysisServices.ts` (analysis). They may only require `BaseServices` (Database, PayloadStore, CredentialCipher)

## Persistence (D1 + Drizzle 1.0 RQB v2)

- `const database = yield* Database; yield* database.run("op.name", (db) => db.query.features.findMany({ where: { ... }, orderBy: { key: "asc" } }))`
- D1 has no interactive transactions: use `db.batch([...])` for atomic multi-statement writes
- Map rows with `packages/persistence/src/mappers.ts` (do not re-implement JSON column decoding)
- Aggregates: Feature (+ feature_environments rows), Experiment (phases/variations as JSON). Repositories return entities,
  not workflow results; orchestration lives in `*ServiceLive.ts`
- Statistics: Holm correction runs per family (primary metric across treatments; secondary metrics x treatments);
  guardrails are uncorrected. A significant guardrail regression must be surfaced wherever a "winning" verdict is shown
- Every mutation of flags / experiments / metrics / data sources / environments / members writes an audit log row
- Any change that affects what SDKs receive (features, experiments, environments) republishes the payload to KV

## Tests

- `bun:test` with `describe` / `it`; test names state the condition and the expected behavior
- DB-backed code is tested against real D1: `const t = await makeTestD1()` from `@furca/database/testing/TestDatabase`
- Don't write tests that only restate types; test behavior (state transitions, phases, SQL results, stats)

## UI (apps/web)

- HeroUI v3 compound components (`@heroui/react`), React Aria props (`onPress`, `isDisabled`, `isSelected`, `value/onChange`).
- Forms: TanStack Form (`@tanstack/react-form`) via the shared `useAppForm` + HeroUI-bound field components in
  `~/components/form`. Validate with Effect Schemas through Standard Schema (reuse contract schemas such as `Key`);
  show server errors on the field they belong to. No hand-rolled `useState` form state or uncontrolled `FormData` forms
- Data: `useQuery(orpc.features.list.queryOptions({ input }))`, `useMutation(orpc.features.create.mutationOptions())`,
  invalidate with `queryClient.invalidateQueries({ queryKey: orpc.features.key() })` (`~/lib/rpc`)
- Reuse `~/components/ui/primitives` (PageHeader, Panel, EmptyState, Code, CopyButton, ListSkeleton, QueryError, RelativeTime),
  `useEnvironment()` for the selected environment, lucide-react icons, `toast` from HeroUI for feedback
- Color is semantic (DESIGN.md): `text-win` / `text-lose` / `text-health` only for results and health. Tables, not card grids.
  No modal when inline editing works. Every list has loading (skeleton), empty (teaching) and error (retry) states
- No new UI dependencies without a reason (recharts is available for timeseries)
