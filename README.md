# typebox-standard-schema

[![npm version](https://img.shields.io/npm/v/typebox-standard-schema.svg)](https://www.npmjs.com/package/typebox-standard-schema)
[![CI](https://github.com/krowten/typebox-standard-schema/actions/workflows/ci.yml/badge.svg)](https://github.com/krowten/typebox-standard-schema/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

typebox-standard-schema makes every [TypeBox](https://github.com/sinclairzx81/typebox) 1.x schema a [Standard Schema](https://standardschema.dev) validator, so it works directly in tRPC, Hono, Elysia, TanStack Form, React Hook Form, SvelteKit remote functions and the other tools that accept Zod or Valibot, with no adapter. From one schema it also derives the request and response shapes, using JSON Schema `readOnly` and `writeOnly`, and it emits clean JSON Schema for OpenAPI, AI SDK tools and MCP.

**[Documentation](https://krowten.github.io/typebox-standard-schema/)** · [Framework integrations](https://krowten.github.io/typebox-standard-schema/integrations) · [JSON Schema & OpenAPI](https://krowten.github.io/typebox-standard-schema/json-schema)

## Why

I love TypeBox: JSON Schema as the single source of truth, static types inferred for free, and one of the fastest validators around. The one thing it lacks out of the box is the [Standard Schema](https://standardschema.dev) interface that more and more tools now expect from a validator — so I built this wrapper, and added a couple of practical features along the way: readOnly/writeOnly projections that derive input and output shapes from a single schema, and form-friendly validation with coercion and field-level errors.

### Other ways to get there

- **[TypeMap](https://github.com/sinclairzx81/typemap)**, by TypeBox's author, compiles a schema into a validator that carries `~standard`. It is built for the 0.34 line (`@sinclair/typebox`), not TypeBox 1.x, and the validator is a separate object: you pass `Compile(User)` around rather than `User`.
- **A hand-written adapter** around `typebox/compile` covers the happy path in a dozen lines. What it leaves out is most of this package: an issue with a path for every field, coercion and defaults that don't touch the caller's object, typed `InferInput` / `InferOutput`, Standard JSON Schema for OpenAPI and AI tools, read/write projections, and validation that stays fast on recursive unions.
- **Zod, Valibot or ArkType**, if JSON Schema doesn't need to be the source of truth: see the [comparison](https://krowten.github.io/typebox-standard-schema/comparison).

## Features

- **Standard Schema out of the box** — every schema built via `Type` carries `~standard`, so it plugs directly into tRPC, Hono, Elysia, TanStack Form, React Hook Form, SvelteKit remote functions, or anything else that accepts a Standard Schema ([tested integrations](#works-with)). Validation is lazy: nothing compiles until the first `validate` call.
- **Standard JSON Schema** — `schema['~standard'].jsonSchema.input()` / `.output()` return plain JSON Schema (draft 2020-12, draft-07 or OpenAPI 3.0) for the shape the schema validates. The AI SDK, the MCP TypeScript SDK and Elysia's OpenAPI plugin read it directly.
- **Fully typed at the integration boundary** — `StandardSchemaV1.InferInput`/`InferOutput` resolve to real shapes, receiver-aware: a full schema advertises the write shape it validates, `Type.Read(User)` its read shape. Conformance is pinned by tests against the official `@standard-schema/spec` types.
- **Read/write projections** — mark fields with `Type.Readonly` / `Type.Writeonly`, then derive input and output shapes (runtime *and* static types) with `Type.Write` / `Type.Read`. Projections recurse through the whole tree: nested schemas, arrays, unions, intersections, `Type.Dependent` branches and `Type.Cyclic` definitions.
- **PATCH-safe partial schemas** — `Type.Partial` strips property defaults, so validating a partial update never silently resets an absent field to its default value.
- **Self-contained schemas** — compose by value (nest schema objects directly); recursive types use `Type.Cyclic`. No registry, no cross-file `$ref` bookkeeping: every schema is a plain JSON tree that validates standalone.
- **JIT-compiled validation** — schemas compile once via `typebox/compile` and are cached; inputs are coerced (`Convert`) and defaulted (`Default`) without mutating the original value.

## Installation

```bash
bun add typebox-standard-schema
# or
npm install typebox-standard-schema
```

typebox is a regular dependency of this package — don't install it separately, and don't import it directly: the curated export surface (`Type`, `validate`, `Value`, types) is the entire public API, and schemas built by a stray second TypeBox would miss `~standard`. TypeScript (>=5) is an optional peer dependency.

## Usage

```ts
import type { Static } from 'typebox-standard-schema'
import { Type, validate } from 'typebox-standard-schema'

const User = Type.Object(
  {
    id: Type.Readonly(Type.String()),
    email: Type.String({ format: 'email' }),
    password: Type.Writeonly(Type.String({ minLength: 8 })),
  },
  { $id: '/user' }, // optional — a name for doc generators, nothing more
)

// Input shape: no readOnly fields → { email, password }
const CreateUser = Type.Write(User)
type CreateUser = Static<typeof CreateUser>

// Output shape: no writeOnly fields → { id, email }
const PublicUser = Type.Read(User)

// Direct validation (validates the write projection — inputs are the common case)
const result = validate(User, { email: 'a@b.c', password: 'secret123' })
if (result.success)
  console.log(result.data) // typed as the write shape: { email, password }
else console.log(result.errors) // [{ message, keyword, params, path }]

// Or hand the schema to any Standard Schema consumer — ~standard is already there
User['~standard'].validate({ email: 'a@b.c', password: 'secret123' })

// Consumers infer real types through the spec, receiver-aware
// (import type { StandardSchemaV1 } from '@standard-schema/spec'):
type In = StandardSchemaV1.InferInput<typeof User> // { email, password } — the write shape
type Out = StandardSchemaV1.InferOutput<typeof PublicUser> // { id, email } — the read shape
```

### Named projections

Options clone a projection into a standalone schema. `suffix` renames every `$id` in the tree — `'/user'` → `'/user/input'`, nested ids too — so read and write shapes get distinct names for doc generators. GraphQL-style naming works the same: `{ $id: 'User' }` + suffix `'Input'` → `'UserInput'`. Cyclic subtrees are renamed consistently (`$defs` keys, `$id`s and `$ref`s move together), so local resolution keeps working. Any other option overrides the root — an explicit `$id` wins over the suffixed one.

```ts
const UserInput = Type.Write(User, { suffix: '/input' }) // $id: '/user/input'
```

## Works with

Each of these was run against a project created with the framework's own starter (types, valid and invalid requests, the projection strip):

| Server | Forms and full-stack |
| --- | --- |
| [Elysia](https://krowten.github.io/typebox-standard-schema/integrations#elysia) — `body: Type.Write(User)` | [SvelteKit remote functions](https://krowten.github.io/typebox-standard-schema/integrations#sveltekit-remote-functions) — `form(Type.Write(User), …)` |
| [Hono](https://krowten.github.io/typebox-standard-schema/integrations#hono) — `sValidator('json', Type.Write(User))` | [TanStack Form](https://krowten.github.io/typebox-standard-schema/integrations#tanstack-form) / [Router](https://krowten.github.io/typebox-standard-schema/integrations#tanstack-router) |
| [tRPC](https://krowten.github.io/typebox-standard-schema/integrations#trpc) — `.input(Type.Write(User)).output(Type.Read(User))` | [React Hook Form](https://krowten.github.io/typebox-standard-schema/integrations#react-hook-form) — `standardSchemaResolver(…)` |
| [oRPC](https://krowten.github.io/typebox-standard-schema/integrations#orpc), [h3 / Nitro](https://krowten.github.io/typebox-standard-schema/integrations#h3-and-nitro) | [next-safe-action](https://krowten.github.io/typebox-standard-schema/integrations#next-safe-action), [T3 Env](https://krowten.github.io/typebox-standard-schema/integrations#t3-env), [Nuxt UI](https://krowten.github.io/typebox-standard-schema/integrations#nuxt-ui) |
| [Fastify](https://krowten.github.io/typebox-standard-schema/integrations#fastify) — as plain JSON Schema | [AI SDK](https://krowten.github.io/typebox-standard-schema/json-schema#ai-sdk-tools), [MCP SDK](https://krowten.github.io/typebox-standard-schema/json-schema#mcp-tools) — via Standard JSON Schema |

```ts
// Hono: the client's `id` is dropped, `body` is typed { email, password }
app.post('/users', sValidator('json', Type.Write(User)), c => c.json(save(c.req.valid('json'))))
```

## JSON Schema and OpenAPI

A TypeBox schema already is JSON Schema, and every schema here also implements [Standard JSON Schema](https://standardschema.dev/json-schema), so a tool can ask for a clean copy in the draft it needs:

```ts
User['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
// { $schema: '…/2020-12/schema', type: 'object', required: ['email', 'password'],
//   properties: { email: { …, format: 'email' }, password: { …, writeOnly: true } } }

Type.Read(User)['~standard'].jsonSchema.output({ target: 'openapi-3.0' })
// { type: 'object', required: ['id', 'email'], properties: { id: { …, readOnly: true }, email: { … } } }
```

Both methods describe what the schema validates: a full schema as its write projection, `Type.Read`/`Type.Write` as themselves. `input` leaves properties with a `default` optional; `output` marks them required, since validation fills them in. Every call returns a fresh object.

- **Targets:** `draft-2020-12`, `draft-07` and `openapi-3.0`; any other target throws. `Type.Cyclic` definitions are hoisted into `$defs` (or `definitions`) with real JSON pointers. OpenAPI 3.0 has no local definitions, so a recursive schema there needs `libraryOptions: { components }` (the definitions are written to `components.schemas`).
- **`$id`** is stripped by default (the same schema nested twice would otherwise repeat an `$id`, which Ajv rejects); pass `libraryOptions: { keepIds: true }` to keep the names for a doc generator.
- **What JSON Schema can't say** throws: `Type.BigInt`, `Type.Undefined`, `Type.Function` and the like have no JSON Schema form.
- Coercion isn't advertised: the schema says `number` even though `validate` also accepts `'42'`, and `array` even though a single string is accepted as a one-item array (a form field sent once).

`@standard-community/standard-json` (used by hono-openapi) picks a converter by vendor name and doesn't read `~standard.jsonSchema` yet; register one line for it:

```ts
import { loadVendor } from '@standard-community/standard-json'

loadVendor('typebox', schema => schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }))
```

## Composing schemas

Nest schemas **by value** — the tree stays self-contained, static types and projections flow through with zero hints:

```ts
const Post = Type.Object(
  {
    title: Type.String(),
    author: User, // readOnly/writeOnly fields inside are projected recursively
  },
  { $id: '/post' },
)
```

`$id` survives projections, so a doc generator can walk any schema tree, extract every node carrying an `$id` into named components (OpenAPI, GraphQL, OpenRPC — whatever the target), and replace occurrences with links.

## Recursive schemas

Value composition cannot express cycles (a `const` cannot reference itself in its own initializer — that's JavaScript, not a library limitation). For recursion use `Type.Cyclic`: definitions live in the schema's own `$defs` and string refs resolve locally, so the schema stays self-contained and static inference works through the cycle:

```ts
const Tree = Type.Cyclic({
  Node: Type.Object({
    value: Type.String(),
    children: Type.Array(Type.Ref('Node')), // resolves against $defs, not a registry
  }),
}, 'Node')

type Tree = Static<typeof Tree> // { value: string, children: Tree[] } — recursive
```

`Type.Read` / `Type.Write` project `$defs` definitions too. Note: `Type.Ref` is only meaningful inside `Type.Cyclic` — there is no global registry to resolve against anywhere else.

## Partial updates

`Type.Partial` makes every property optional **and strips property defaults**. Plain TypeBox keeps `default` annotations on the now-optional fields, so validating a PATCH body would quietly materialize defaults — an update without `status` would reset it to `'draft'`:

```ts
const Article = Type.Object({
  title: Type.String(),
  status: Type.Union(
    [Type.Literal('draft'), Type.Literal('published')],
    { default: 'draft' },
  ),
})

const ArticlePatch = Type.Partial(Article)

validate(ArticlePatch, { title: 'New title' })
// → { success: true, data: { title: 'New title' } }
//   `status` stays absent — a missing field means "leave it unchanged"
```

The strip is shallow, matching `Type.Partial`'s own semantics: a nested object, when present in the input, still validates (and defaults) against its full schema. Explicit `Type.Optional(Type.X({ default }))` outside `Partial` keeps working — there the default is a deliberate choice:

```ts
const Query = Type.Object({
  page: Type.Optional(Type.Integer({ default: 1 })),
})

validate(Query, {}) // → { success: true, data: { page: 1 } }
```

## Validation

`validate(schema, data)` and `schema['~standard'].validate(data)` share one pipeline:

1. **Clone** — the input is cloned first; your original value is never mutated. Payloads `structuredClone` refuses (functions, symbols, class instances with methods) fall back to a structural copy — validation never throws on weird input, it reports it.
2. **Default** — missing values — absent keys and `undefined` — with a `default` annotation are filled in before anything is converted (except through `Type.Partial` — see above).
3. **Convert** — form-friendly coercion, so values read from `FormData`, a query string or `process.env` validate without manual parsing. Pass a plain object, not the `FormData` instance itself — e.g. `Object.fromEntries(formData)`, collecting repeated keys and files yourself where your form has them. Only strings are converted, by [Ajv's `coerceTypes`](https://ajv.js.org/coercion.html) rules, and only when the result means the same thing:

   | To | From |
   | --- | --- |
   | number, integer | a numeric string: `'42'`, `' 4.5 '`, `'1e3'` |
   | boolean | `'true'`, `'false'` |
   | null | `''` |
   | array | a lone string, as a one-item array (a form field sent once) |

   Any other string fails validation: `''` and `'abc'` are not numbers, `'1.5'` is not an integer, `'Infinity'` is not a JSON number, `'1'` and `'yes'` are not booleans. Values that aren't strings are never converted, so in a JSON body `null`, `true` or `123` where the schema wants something else is reported, not turned into `0`, `1` or `'123'`. A value that already passes is left alone: `'5'` stays a string in `Type.Union([Type.Number(), Type.String()])`. `undefined` means "no value": it has already received its default in the previous step or is reported as missing.
4. **Check** — the JIT-compiled validator judges the data *as it arrived*: every constraint, `if`/`not`/`oneOf` included, sees what the full schema would see. The one allowance: a field the projection cut may be missing — it is still checked against its own schema when present, and a `Type.Read` of an `additionalProperties: false` schema still accepts a full database row. A client-supplied `readOnly` field of the wrong type is therefore an error rather than something quietly dropped (unless Convert can turn it into the right type: `id: '7'` for an integer id is converted, then stripped). Compilation happens once per schema (cached by identity), on first use — so treat a schema as immutable once it has validated anything: editing it in place afterwards (`schema.minimum = 10`) is not picked up. Build a new schema instead.
5. **Strip** — the fields a projection cut are deleted from the result: a `Type.Read` result can't carry a `writeOnly` secret, a `Type.Write` result can't carry a client-supplied `readOnly` id. This is what makes a projection an actual boundary rather than a description. It follows the data through nested objects, arrays, tuples, records, unions, intersections, `Type.Dependent` branches (a field marked in `if` included), `Type.Cyclic` definitions and `$ref`s (JSON pointers, `$id`, `$anchor`). A field cut by anything that applies to the value unconditionally — an intersection member, the `Type.Dependent` branch taken — is always removed. A field cut only in some union variant is removed unless another variant the value actually matches declares it: a variant that merely tolerates extra keys never echoes back another variant's secret. Nothing else is touched: an undeclared key the schema allows stays.

   Marks count where they describe a field: on a property schema, in an object, intersection member, union variant or `Type.Dependent` branch (a field marked in `if` included). A mark on a `Type.Cyclic` definition, an array item or a record value describes the value there, not a field, and cuts nothing. When a `Type.Dependent`'s `if` reads a field the projection cuts, the result is the validated data minus that field; checked against the projection's own `if` again, it may fall into the other branch. A `$ref` that can't be resolved while there are fields to cut fails the validation (`$ref` issue) rather than guessing.

Error reporting follows TypeBox's, issue for issue — except in schemas that recurse (`Type.Cyclic`) and branch (unions), where collecting every error of every branch would take exponential time: there a failed union reports the issues of the branch the value meant (a tagged union, told apart by a literal discriminator) or a single `anyOf` issue.

Two `Type.Cyclic` with the same definition name in one schema collide in TypeBox's own reference resolution — name definitions uniquely.

Data that can't be validated at all — cyclic data where a union or recursive schema would follow it, nesting deeper than the stack allows, a getter that throws — comes back as an issue (`circular`, `depth`, `unreadable`), never as an exception.

A full schema validates against its **write projection** — inputs are the common case. A projection obtained from `Type.Read`/`Type.Write` validates as itself. `Type.Partial`, `Type.Required`, `Type.Pick` and `Type.Omit` of a projection are still that projection. A schema built around one — `Type.Array(Type.Read(User))`, `Type.Object({ user: Type.Read(User) })`, `Type.Intersect([Type.Read(A), Type.Read(B)])` and what `Type.Evaluate`/`Type.Interface` make of it — is a new full schema and validates as its write projection, the fields the inner projection cut still cut; to validate the whole thing as a read shape, project the whole thing: `Type.Read(Type.Array(User))`. The static type follows: `validate(User, ...)` returns the write shape (the `readOnly` fields it strips are gone from the type too), `validate(Type.Read(User), ...)` returns the read shape.

When you want the data or an exception rather than a result object, use `parse` — same pipeline, same target rules:

```ts
import { isValidationError, parse } from 'typebox-standard-schema'

try {
  const user = parse(User, await request.json()) // typed as the write shape
}
catch (error) {
  if (isValidationError(error))
    console.log(error.issues) // same ValidationIssue[] as validate()
}
```

Errors come back as flat, form-ready issues:

```ts
type ValidationIssue = {
  message: string // English text from typebox
  keyword: string // ajv-style: 'required', 'format', 'minLength', ...
  params: Record<string, unknown> // e.g. { format: 'email' } — enough for i18n mapping
  path: (string | number)[] // ['info', 'height'] — field path segments
}
```

A missing-properties error is fanned out into one issue per field (with `path` pointing at each), so form libraries can attach every message to its input.

Formats (`email`, `uuid`, `date-time`, ...) are built into typebox 1.x and enforced by default — no registration needed.

## Custom formats and types

Register your own formats through the exported `Format` registry. Registration order doesn't matter: a change to the registry makes every schema recompile on its next validation, so a format registered (or replaced) after a schema has already validated still applies. Until a format is registered it is ignored, per JSON Schema semantics:

```ts
import { Format, Type, validate } from 'typebox-standard-schema'

Format.Set('hex-color', value => /^#[0-9a-f]{6}$/i.test(value))

const Theme = Type.Object({ accent: Type.String({ format: 'hex-color' }) })
validate(Theme, { accent: 'red' })
// → { success: false, errors: [{ keyword: 'format', params: { format: 'hex-color' }, ... }] }
```

For custom schema nodes use `Type.Unsafe`: hand it any JSON Schema the engine understands and pin the static type via the generic — the result carries `~standard` and composes like every other schema:

```ts
const Celsius = Type.Unsafe<number>({ type: 'number', minimum: -273.15 })

const Weather = Type.Object({ temp: Celsius })
type Weather = Static<typeof Weather> // { temp: number }
```

## Adopting external schemas

Schemas produced by other TypeBox-based generators — e.g. [`drizzle-typebox`](https://orm.drizzle.team/docs/typebox), which derives TypeBox schemas from your Drizzle ORM tables — are plain JSON Schema objects, but they are not created through this package's `Type`, so they don't get `~standard` automatically. Pass them through `adopt()` to attach it:

```ts
import { createInsertSchema } from 'drizzle-typebox'
import { adopt } from 'typebox-standard-schema'

const InsertUser = adopt(createInsertSchema(usersTable))
InsertUser['~standard'].validate(data) // now a Standard Schema
```

## API

Everything ships from the single entry point, `typebox-standard-schema`.

| Export | Description |
| --- | --- |
| `Type` | The schema builder — all TypeBox factories (`Object`, `String`, `Union`, `Cyclic`, ...), every result carrying `~standard`, plus the methods below. |
| `Type.Readonly(schema)` | Marks a field as output-only (`readOnly: true`) — kept by `Type.Read`, cut by `Type.Write`. Replaces TypeBox's own type-level-only `Readonly`. |
| `Type.Writeonly(schema)` | Marks a field as input-only (`writeOnly: true`) — kept by `Type.Write`, cut by `Type.Read`. |
| `Type.Read(schema, options?)` | Output projection: drops `writeOnly` fields (runtime + static). Memoized per schema; with `options` returns a standalone named clone. |
| `Type.Write(schema, options?)` | Input projection: drops `readOnly` fields. Same memoization and options. |
| `Type.Partial(schema, options?)` | TypeBox's `Partial` + strips property defaults for PATCH-safe partial updates. |
| `validate(schema, data)` | Runs the pipeline above; returns `{ success: true, data }` or `{ success: false, errors }`. `data` is typed as the shape actually checked — see `TValidated`. |
| `parse(schema, data)` | Assert-style: returns the validated data or throws a `ValidationError`. |
| `isValidationError(e)` | Type guard for the error `parse` throws (`e.issues` carries the details). |
| `adopt(schema)` | Attaches `~standard` to a schema built outside this package. |
| `Format` | The format registry — `Format.Set('name', fn)` to register custom string formats; a change recompiles schemas on their next validation. |
| `Value` | Re-export of `typebox/value` for ad-hoc operations (`Value.Check`, `Value.Clone`, ...). |
| `Static<T>` | Static type inference for a schema (re-exported from typebox). |
| `ValidationResult<T>`, `ValidationIssue`, `ValidationError` | The result union, the issue shape, and the error `parse` throws. |
| `TRead<T>`, `TWrite<T>`, `TReadonly<T>`, `TWriteonly<T>` | Type-level companions of the projections and field marks. |
| `TValidated<T>` | The shape `validate` checks: `TWrite<T>` for a full schema, `T` itself when it already is a projection. |
| `ProjectionOptions` | Options accepted by `Type.Read`/`Type.Write` (`suffix` + any schema options). |
| `schema['~standard'].jsonSchema` | `input(options)` / `output(options)` — [Standard JSON Schema](#json-schema-and-openapi): a fresh JSON Schema of what the schema validates. |
| `JsonSchemaTarget`, `JsonSchemaOptions` | `'draft-2020-12' \| 'draft-07' \| 'openapi-3.0'`, and `{ target, libraryOptions? }` (`keepIds`, `inlineRoot`, `components`). |
| `StandardProps`, `WithStandard<T>` | The `~standard` interface shape and the type `adopt` returns. |
| `TSchema`, `TObject`, `TArray`, `TOptional`, `TProperties`, `TSchemaOptions` | Common TypeBox types, re-exported for convenience. |

## Contributing

Issues and pull requests are welcome — [open one here](https://github.com/krowten/typebox-standard-schema/issues).

The project uses [Bun](https://bun.sh):

```bash
bun install        # dependencies
bun run test       # everything: unit tests, the built package as a consumer sees it, the fuzzer
bun test           # unit, type-level and seeded property tests only (bun:test, src/*.test.ts)
bun run check      # typecheck (tsc --noEmit)
bun run lint       # ESLint (@antfu config)
bun run build      # bundle dist/ via tsdown
bun run site:dev   # the documentation site (site/)
```

Ground rules:

- **Tests first.** The project is developed test-first: add a failing test that captures the behavior, then make it pass. Please cover behavior changes with tests.
- `src/index.ts` is the only public entry point and its export surface is curated on purpose — consumers must never need to import `typebox` directly.
- No classes; `type` over `interface`; module privacy is simply not exporting.
- Run `bun run test`, `bun run check` and `bun run lint` before opening a PR — CI runs the same checks.

## License

MIT © [Vladimir Kraikovskii](https://github.com/krowten)
