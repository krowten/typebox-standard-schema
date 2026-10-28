# JSON Schema & OpenAPI

A TypeBox schema is already a JSON Schema object. On top of that, every schema here implements [Standard JSON Schema](https://standardschema.dev/json-schema): `schema['~standard'].jsonSchema` hands out a clean copy in the draft a tool asks for. OpenAPI generators, AI SDK tools and MCP servers read it without a converter of their own.

```ts
import { Type } from 'typebox-standard-schema'

const User = Type.Object({
  id: Type.Readonly(Type.String()),
  email: Type.String({ format: 'email' }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
})

User['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
// {
//   $schema: 'https://json-schema.org/draft/2020-12/schema',
//   type: 'object',
//   required: ['email', 'password'],
//   properties: {
//     email: { type: 'string', format: 'email' },
//     password: { type: 'string', minLength: 8, writeOnly: true },
//   },
// }

Type.Read(User)['~standard'].jsonSchema.output({ target: 'openapi-3.0' })
// {
//   type: 'object',
//   required: ['id', 'email'],
//   properties: {
//     id: { type: 'string', readOnly: true },
//     email: { type: 'string', format: 'email' },
//   },
// }
```

## What you get

Both methods describe the shape the schema validates:

- a full schema such as `User` gives its **write projection** (`readOnly` fields cut), because that's what `validate` checks it against;
- `Type.Read(User)` and `Type.Write(User)` give themselves, and so do `Type.Partial`, `Pick` and `Omit` of a projection.

In an OpenAPI document generated from these, the request body has no `id` and the response has no `password`.

`input` and `output` differ only in defaults. Validation fills a missing property from its `default`, so `input` leaves such properties optional and `output` marks them required.

Every call builds a fresh object. Some consumers (the AI SDK is one) modify the schema they receive, and that can't reach your schema or the next caller.

## Targets

| `target` | Output |
| --- | --- |
| `draft-2020-12` | `$schema` header, definitions under `$defs`, tuples as `prefixItems` |
| `draft-07` | `$schema` header, definitions under `definitions`, tuples as `items` arrays, `$ref` siblings wrapped in `allOf` |
| `openapi-3.0` | no header, `const` → `enum`, `nullable: true` instead of a `null` type, boolean exclusive bounds, records as `additionalProperties` |

Any other target throws, as the spec asks.

`Type.Cyclic` definitions are lifted to the root and referenced with real JSON pointers (`#/$defs/Node`). When the root itself is the recursive type, its definition is inlined, so the root states `type: 'object'`, which MCP and most LLM providers require. OpenAPI 3.0 has no local definitions: a recursive schema needs a place to put them.

```ts
const components = { schemas: {} }
const schema = Tree['~standard'].jsonSchema.input({
  target: 'openapi-3.0',
  libraryOptions: { components },
})
// the root is inlined; its recursive refs point to '#/components/schemas/Node',
// which now holds the definition
```

### Options

`libraryOptions` takes:

- `keepIds` (default `false`): keep `$id`. It's stripped by default, because nesting the same schema twice would repeat an `$id` and Ajv refuses to compile that. Turn it on when a doc generator should use the names.
- `inlineRoot` (default `true`): inline a root that is only a `$ref`.
- `components`: the OpenAPI 3.0 bag described above.

### What can't be converted

Some TypeBox kinds have no JSON Schema form: `Type.BigInt`, `Type.Undefined`, `Type.Void`, `Type.Symbol`, `Type.Function`. Converting a schema that contains one throws an error naming the kind. Keywords a target can't express (`if`/`then`/`else` in OpenAPI 3.0, `unevaluatedProperties` in draft-07) throw too, instead of silently changing what the schema means.

The emitted schema describes the data, not the coercion: it says `type: 'number'` even though `validate` also accepts `'42'` from a form, and `type: 'array'` even though a single string is accepted as a one-item array.

## OpenAPI with Elysia

`@elysiajs/openapi` reads `~standard.jsonSchema` on its own. The route below shows up with a request body without `id` and a `200` response without `password`:

```ts
import { openapi } from '@elysiajs/openapi'
import { Elysia } from 'elysia'

new Elysia()
  .use(openapi())
  .post('/users', ({ body }) => createUser(body), {
    body: Type.Write(User),
    response: Type.Read(User),
  })
```

## OpenAPI with oRPC

oRPC's `OpenAPIGenerator` needs a converter per schema library. Point it at `jsonSchema`; oRPC passes `strategy` as `'input'` or `'output'`:

```ts
import type { ConditionalSchemaConverter } from '@orpc/openapi'
import { OpenAPIGenerator } from '@orpc/openapi'

const typebox: ConditionalSchemaConverter = {
  condition: schema => schema?.['~standard'].vendor === 'typebox',
  convert: (schema, { strategy }) => [
    true,
    (schema as typeof User)['~standard'].jsonSchema[strategy]({ target: 'draft-2020-12' }),
  ],
}

const spec = await new OpenAPIGenerator({ schemaConverters: [typebox] })
  .generate(router, { info: { title: 'API', version: '1.0.0' } })
```

## OpenAPI with Hono

`hono-openapi` converts schemas with `@standard-community/standard-json`, which picks a converter by vendor name and doesn't read `~standard.jsonSchema` yet. Register one for `typebox` once, at startup:

```ts
import { loadVendor } from '@standard-community/standard-json'

loadVendor('typebox', schema =>
  schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }))
```

## Fastify

Fastify takes the schemas as plain JSON Schema (see [Framework integrations](/integrations#fastify)), and `@fastify/swagger` documents them as they are: `Type.Write(User)` as the body, `Type.Read(User)` as the response.

## AI SDK tools

The AI SDK accepts the schemas as tool input. It sends the JSON Schema to the model and validates the model's arguments through `~standard.validate`, so defaults and coercion apply:

```ts
import { tool } from 'ai'

const weather = tool({
  description: 'Current weather for a city',
  inputSchema: Type.Object({
    city: Type.String(),
    unit: Type.Optional(Type.Union([Type.Literal('c'), Type.Literal('f')], { default: 'c' })),
  }),
  execute: async ({ city, unit }) => getWeather(city, unit),
})
```

## MCP tools

The MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) takes Standard Schema for both the input and the output of a tool:

```ts
import { McpServer } from '@modelcontextprotocol/server'

const Note = Type.Object({
  id: Type.Readonly(Type.String()),
  title: Type.String(),
  body: Type.String(),
})

const server = new McpServer({ name: 'notes', version: '1.0.0' })

server.registerTool('create-note', {
  description: 'Create a note',
  inputSchema: Type.Write(Note), // the model can't supply an id
  outputSchema: Type.Read(Note),
}, async ({ title, body }) => {
  const note = { id: crypto.randomUUID(), title, body }
  return { content: [{ type: 'text', text: JSON.stringify(note) }], structuredContent: note }
})
```

Version 1 of the SDK (`@modelcontextprotocol/sdk`) accepts only Zod schemas.
