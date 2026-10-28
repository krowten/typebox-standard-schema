# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) (0.x — minor may break).

## [0.1.0] — 2026-10-28

First public release.

### Added

- **Standard Schema v1 out of the box.** Every schema built with `Type`
  carries `~standard`, so it plugs directly into tRPC, Hono, Elysia,
  TanStack Form, React Hook Form, SvelteKit remote functions and anything
  else that accepts a Standard Schema. Validation is lazy: nothing compiles
  until the first use.
- **Standard JSON Schema.** `schema['~standard'].jsonSchema.input({ target })`
  and `.output({ target })` return plain JSON Schema for `draft-2020-12`,
  `draft-07` or `openapi-3.0`, describing what the schema validates. The AI
  SDK, the MCP TypeScript SDK and Elysia's OpenAPI plugin read it without a
  converter. `Type.Cyclic` definitions are hoisted into `$defs` /
  `definitions`.
- **Typed at the integration boundary.** `StandardSchemaV1.InferInput` /
  `InferOutput` resolve to real shapes: a full schema advertises the write
  shape it validates, `Type.Read(User)` its read shape. Conformance is tested
  against the official `@standard-schema/spec` types, both at the source
  level and against the built package.
- **Read/write projections.** Mark fields with `Type.Readonly` /
  `Type.Writeonly`, then derive input and output shapes, runtime and static
  types alike, with `Type.Write` / `Type.Read`. Projections follow the whole
  tree: nested objects, arrays, tuples, records, unions, intersections,
  `Type.Dependent` branches, `Type.Cyclic` definitions and `$ref`s. Fields a
  projection cuts are removed from the validated result, so a read result
  can't carry a `writeOnly` secret and a write result can't carry a
  client-supplied `readOnly` id. Named projections (`{ $id, suffix }`) give
  derived shapes distinct names for doc generators.
- **`validate(schema, data)`**: Clone → Default → Convert → Check → Strip,
  returning `{ success, data }` or `{ success: false, errors }` with flat,
  form-ready issues (`message` / `keyword` / `params` / `path`). It never
  mutates the input and never throws: cyclic, too deep or unreadable data
  comes back as an issue.
- **Form-friendly coercion.** Strings are converted by Ajv's `coerceTypes`
  rules, and only when the result means the same thing: numeric strings to
  numbers, `'true'` / `'false'` to booleans, `''` to `null`, a lone string to
  a one-item array. Values that aren't strings are never converted. Data
  that already passes skips conversion.
- **`parse(schema, data)`**: the assert-style counterpart, returning the
  validated data or throwing a `ValidationError` (`isValidationError()`
  narrows it).
- **PATCH-safe `Type.Partial`**: strips property defaults, so validating a
  partial update never resets an absent field to its default.
- **Self-contained schemas**: compose by value, no registry, no cross-file
  `$ref` bookkeeping; recursive types use `Type.Cyclic`, and validation
  stays fast on recursive unions.
- **`adopt(schema)`** brings a schema built outside this package (for
  example by `drizzle-typebox` on `@sinclair/typebox` 0.34, or a hand-written
  JSON Schema with `$defs` and pointer refs) into `~standard`.
- **`Format`**: custom string formats; registration order doesn't matter,
  a schema that has already validated picks up a format registered later.
  `Value` is re-exported for ad-hoc checks.
