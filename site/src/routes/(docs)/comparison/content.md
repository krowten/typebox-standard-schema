# TypeBox vs Zod, Valibot and ArkType

Most TypeScript frameworks now accept any [Standard Schema](https://standardschema.dev), so tRPC, Hono or TanStack Form don't force a validation library on you anymore. With this package TypeBox joins Zod, Valibot and ArkType on that list. What's left to decide is which kind of schema you want to write and maintain.

## The short version

**Pick TypeBox** when the schema should be JSON Schema first:

- you publish an OpenAPI document, or share schemas with services that aren't TypeScript;
- you hand schemas to LLMs as tool definitions, where JSON Schema is the format the model sees;
- one model needs a request shape and a response shape, and you'd rather mark fields `readOnly` / `writeOnly` once than maintain `CreateUser`, `UpdateUser` and `UserResponse` by hand ([projections](/projections));
- you want each schema compiled once into a JavaScript validator, the way TypeBox does it.

**Pick Zod** when you want the largest ecosystem: most tutorials, form libraries and code generators start with Zod, and its API for refinements and transforms is the most familiar to other developers.

**Pick Valibot** when bundle size in the browser matters most: its functions tree-shake down to what a form actually uses.

**Pick ArkType** when you like writing types as TypeScript-like strings (`'string.email'`, `'number > 0'`) and like its fast validation.

## Side by side

| | TypeBox + this package | Zod | Valibot | ArkType |
| --- | --- | --- | --- | --- |
| A schema is | a JSON Schema object | a Zod object | a Valibot object | an ArkType object |
| JSON Schema output | the schema itself, plus `~standard.jsonSchema` | `z.toJSONSchema()` | `@valibot/to-json-schema` | `.toJsonSchema()` |
| Standard Schema | ✅ through this package | ✅ | ✅ | ✅ |
| Standard JSON Schema | ✅ | ✅ (4.2+) | via `toStandardJsonSchema()` | ✅ (2.1.28+) |
| Request/response shapes from one schema | `Type.Write` / `Type.Read` from `readOnly` / `writeOnly` marks | `.omit()` / `.pick()` by hand | `omit()` / `pick()` by hand | `.omit()` / `.pick()` by hand |
| Coercion of form and query strings | built into `validate` | `z.coerce.*` per field | `pipe()` with a transform per field | morphs per field |

The Standard JSON Schema column comes from the [spec's list of implementers](https://standardschema.dev/json-schema#what-schema-libraries-support-this-spec).

## What JSON Schema first means in practice

With Zod, Valibot or ArkType the library's own objects are the source of truth, and JSON Schema is generated from them when a tool asks. With TypeBox the source of truth already is JSON Schema: `JSON.stringify(User)` is the document you'd put in an OpenAPI spec, so no converter can drop a constraint on the way.

The flip side is that what JSON Schema can't describe is harder to express. A refinement that compares two fields, or a transform that turns a string into a `Date`, is a one-liner in Zod. In TypeBox it's custom code, a [custom format](/custom-formats) or a step after validation.

## Other ways to use TypeBox with Standard Schema

- **[TypeMap](https://github.com/sinclairzx81/typemap)**, by TypeBox's author, compiles a schema into a validator that carries `~standard`. It is built for the 0.34 line (`@sinclair/typebox`), not TypeBox 1.x, and the validator is a separate object: you pass `Compile(User)` around rather than `User`.
- **A hand-written adapter** around `typebox/compile` covers the happy path in a dozen lines. What it leaves out is most of this package: an issue with a path for every field, coercion and defaults that don't touch the caller's object, typed `InferInput` / `InferOutput`, Standard JSON Schema for OpenAPI and AI tools, read/write projections, and validation that stays fast on recursive unions.

## Moving from Zod

Concepts map closely:

| Zod | typebox-standard-schema |
| --- | --- |
| `z.object({ ... })` | `Type.Object({ ... })` |
| `z.string().email()` | `Type.String({ format: 'email' })` |
| `z.number().int().min(1)` | `Type.Integer({ minimum: 1 })` |
| `.optional()` | `Type.Optional(...)` |
| `.default(x)` | `{ default: x }` in the options |
| `z.enum(['a', 'b'])` | `Type.Union([Type.Literal('a'), Type.Literal('b')])` |
| `z.infer<typeof S>` | `Static<typeof S>` |
| `S.safeParse(v)` | `validate(S, v)` |
| `S.parse(v)` | `parse(S, v)` |
| `z.coerce.number()` | `Type.Number()`: `validate` converts `'42'` already |

Frameworks don't need to change: the same `.input(schema)` or `validators: { onChange: schema }` call takes either.
