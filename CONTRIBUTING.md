# Contributing

Issues and pull requests are both welcome. Taking part means following the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```sh
bun install
bun run test       # unit tests, the built package as a consumer sees it, the fuzzer
bun run site:dev   # the documentation site
```

The library lives in `src/`, one concern per file; `src/index.ts` is the only public entry
point. `site/` is the documentation site (SvelteKit, its own `package.json`), and
`test/dist-consumer/` compiles a consumer against the built package.

## Before you open a pull request

```sh
bun run lint
bun run check
bun run test
```

`bun run test` runs three stages: `test:unit` (fast, deterministic, what CI runs),
`test:dist` (rebuilds `dist/` and type-checks a consumer against it) and `test:fuzz`
(random schemas from a fresh seed; replay a failure with `--seed`).

## House rules

- Tests first: add a failing test that captures the behaviour, then make it pass.
- The export surface of `src/index.ts` is curated on purpose. Consumers must never need to
  import `typebox` directly.
- No classes; `type` over `interface` unless TypeScript forces one; module privacy is not
  exporting.
- Comments explain constraints the code can't show.
