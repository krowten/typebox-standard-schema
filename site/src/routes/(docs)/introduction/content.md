# Introduction

typebox-standard-schema makes every [TypeBox](https://github.com/sinclairzx81/typebox) 1.x schema a [Standard Schema](https://standardschema.dev) validator, so it works directly in tRPC, Hono, Elysia, TanStack Form, React Hook Form, SvelteKit remote functions and the other tools that accept Zod or Valibot, with no adapter. From one schema it also derives the request and response shapes, using JSON Schema `readOnly` and `writeOnly`, and it emits clean JSON Schema for OpenAPI, AI SDK tools and MCP.

## What is Standard Schema?

[Standard Schema](https://standardschema.dev) is a small TypeScript interface, designed by the authors of Zod, Valibot and ArkType, that a validation library puts on its schemas as a `~standard` property. It holds a `validate` function and the inferred input and output types. A framework that accepts "any Standard Schema" calls `schema['~standard'].validate(value)` and reads the issues it returns, without knowing which library made the schema.

TypeBox builds JSON Schema and validates it very fast, but its schemas don't carry `~standard`, so tools that expect one can't use them directly. This package adds it to every schema you build with its `Type`:

```ts
import { Type } from 'typebox-standard-schema'

const User = Type.Object({ name: Type.String() })

User['~standard'].validate({ name: 'Ann' }) // { value: { name: 'Ann' } }
User['~standard'].validate({ name: [] }) // { issues: [{ message, path: ['name'], ... }] }
```

The companion spec, [Standard JSON Schema](https://standardschema.dev/json-schema), adds `~standard.jsonSchema` for tools that need the schema itself, such as OpenAPI generators and LLM tool definitions. Schemas here implement both; see [JSON Schema & OpenAPI](/json-schema).

## Why

I love TypeBox: JSON Schema as the single source of truth, static types inferred for free, and one of the fastest validators around. The one thing it lacks out of the box is the [Standard Schema](https://standardschema.dev) interface that more and more tools now expect from a validator — so I built this wrapper, and added a couple of practical features along the way: readOnly/writeOnly projections that derive input and output shapes from a single schema, and form-friendly validation with coercion and field-level errors.

## Features

- **Standard Schema out of the box** — every schema built via `Type` carries `~standard`, so it plugs directly into tRPC, Hono, Elysia, TanStack Form, React Hook Form, SvelteKit remote functions, or anything else that accepts a Standard Schema ([tested integrations](/integrations)). Validation is lazy: nothing compiles until the first `validate` call.
- **Standard JSON Schema** — `schema['~standard'].jsonSchema.input()` / `.output()` return plain JSON Schema (draft 2020-12, draft-07 or OpenAPI 3.0) for the shape the schema validates. The AI SDK, the MCP TypeScript SDK and Elysia's OpenAPI plugin read it directly.
- **Fully typed at the integration boundary** — `StandardSchemaV1.InferInput`/`InferOutput` resolve to real shapes, receiver-aware: a full schema advertises the write shape it validates, `Type.Read(User)` its read shape. Conformance is pinned by tests against the official `@standard-schema/spec` types.
- **Read/write projections** — mark fields with `Type.Readonly` / `Type.Writeonly`, then derive input and output shapes (runtime *and* static types) with `Type.Write` / `Type.Read`. Projections recurse through the whole tree: nested schemas, arrays, unions, intersections, `Type.Dependent` branches and `Type.Cyclic` definitions. See [Projections](/projections).
- **PATCH-safe partial schemas** — `Type.Partial` strips property defaults, so validating a partial update never silently resets an absent field to its default value.
- **Self-contained schemas** — compose by value (nest schema objects directly); recursive types use `Type.Cyclic`. No registry, no cross-file `$ref` bookkeeping: every schema is a plain JSON tree that validates standalone.
- **JIT-compiled validation** — schemas compile once via `typebox/compile` and are cached; inputs are coerced (`Convert`) and defaulted (`Default`) without mutating the original value.

Ready to try it? Head to [Getting started](/getting-started).
