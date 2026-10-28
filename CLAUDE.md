# typebox-standard-schema

Standard Schema v1 wrapper over typebox 1.x with readOnly/writeOnly schema
projections. Schemas compose by value (self-contained trees, no registry);
recursive types use `Type.Cyclic`. Source lives in `src/`, one concern per
file; `src/index.ts` is the only public entry point and its export surface is
curated on purpose — consumers must never import `typebox` directly.

## Tooling

Use Bun, not Node.js/npm:

- `bun install` — dependencies
- `bun run test` — everything below in order, stopping at the first failure:
  - `bun run test:unit` (= `bun test`) — unit, type-level and seeded property
    tests (bun:test, colocated as `src/*.test.ts`); fast and deterministic, the
    one CI and `prepublishOnly` run
  - `bun run test:dist` (= `check:dist`) — the built package seen by a consumer
  - `bun run test:fuzz` — the random-seed fuzzer (see below)
- `bun run check` — typecheck (`tsc --noEmit`)
- `bun run check:dist` — rebuild, then typecheck `test/dist-consumer/` — a
  consumer stand that imports the package by name (through `exports`, no
  `paths`) and asserts `StandardSchemaV1.InferInput/InferOutput` still resolve
  against the *built* `dist/`. It is excluded from the root tsconfig on
  purpose: importing the built package pulls `dist/index.d.mts` into the
  program alongside `src/augment.ts`.
- `bun run test:fuzz` — property-based fuzzer (`test/fuzz/`): random schemas and
  data from a fresh seed each run, checked against every projection;
  `--count N`, `--seed S` (replay), `--mode strict|broad`. Exit code 1 on any
  failure, each printed shrunk with a runnable repro. `src/property.test.ts`
  runs the same generator on fixed seeds as part of `test:unit`.
- `bun run lint` / `bun run lint:fix` — ESLint (@antfu config)
- `bun run build` — bundle `dist/` via tsdown (single ESM file + rolled-up
  declarations)
- `bun run site:dev` / `bun run site:build` — the documentation site in
  `site/` (SvelteKit + adapter-static, its own `package.json` and `bun.lock`;
  pages are `site/src/routes/(docs)/<slug>/content.md`, titles and meta
  descriptions in `site/src/lib/nav.ts`; `llms.txt` and `llms-full.txt` are
  generated from the same pages at build). `.github/workflows/pages.yml`
  builds it on every push and deploys only while the repository is public.

## Code style

- No classes.
- `type` over `interface` — interfaces only where TypeScript forces them
  (declaration merging in `src/augment.ts`; lazy member evaluation for the
  self-referential `StandardProps` in `src/standard.ts`); enforced by
  `ts/consistent-type-definitions`.
- No `_`-prefix pseudo-privacy: module privacy = not exporting.
- Relative imports are extension-less (tsdown bundles; tsc only typechecks).

## Docs

The README covers the package surface and is what npm shows; the site in
`site/` carries the longer guides (integrations, JSON Schema & OpenAPI,
comparison). When behaviour changes, update both — several site pages started
as README sections and repeat them.

## Project conventions

- `prepublishOnly` runs the full gate: lint + typecheck + tests + build +
  publint + a check that `declare module 'typebox'` survived the declaration
  rollup + the `test/dist-consumer` compile against that build. Never publish
  around it: the src-level tests stay green against a stale or broken `dist/`,
  and a consumer only sees the built types.
- Releases go out from CI only: pushing a `v*` tag that matches `version` in
  `package.json` runs `.github/workflows/release.yml`, which stages the
  release on npm with provenance (`npm stage publish`, `prepublishOnly`
  included) for the maintainer to approve. Never `npm publish` locally.
- `bun.lock` must reference the public npm registry only — regenerate against
  it if an install rewrites tarball URLs to a private mirror.
