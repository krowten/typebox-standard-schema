# Framework integrations

Every schema built with this package's `Type` carries `~standard`, so any tool that accepts a [Standard Schema](https://standardschema.dev) takes it as is. There's no adapter package to install and nothing to register.

The examples below share one schema:

```ts
import { Type } from 'typebox-standard-schema'

const User = Type.Object({
  id: Type.Readonly(Type.String()),
  name: Type.String({ minLength: 1 }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
})
```

Validate request bodies, form values and arguments against `Type.Write(User)`: a client can't set `id`, and if it sends one anyway, the field is dropped before your handler sees it. Validate what you send back against `Type.Read(User)` where the framework checks output: `password` never leaves the server.

Each integration below was run against a real project created with the framework's own starter: type inference, a valid request, an invalid one, and the projection strip.

| Library | Tested version | Input | Output | Read-only field from the client |
| --- | --- | --- | --- | --- |
| [Elysia](#elysia) | 1.4.30 | ✅ | ✅ | dropped |
| [Hono](#hono) (`@hono/standard-validator`) | 4.13 / 0.4.0 | ✅ | — | dropped |
| [tRPC](#trpc) | 11.19 | ✅ | ✅ | dropped |
| [oRPC](#orpc) | 1.15.7 | ✅ | ✅ | dropped |
| [h3 / Nitro](#h3-and-nitro) | h3 2.0.5 | ✅ | — | dropped |
| [Fastify](#fastify) | 5.12.7 | JSON Schema | JSON Schema | kept, unless you use a Standard Schema plugin |
| [SvelteKit remote functions](#sveltekit-remote-functions) | kit 3.1 | ✅ | — | dropped |
| [TanStack Form](#tanstack-form) | 1.33.5 | ✅ | — | see notes |
| [TanStack Router](#tanstack-router) | 1.170 | ✅ | — | see notes |
| [React Hook Form](#react-hook-form) | 7.90 / resolvers 5.9 | ✅ | — | dropped |
| [next-safe-action](#next-safe-action) | 8.7.3 | ✅ | — | dropped |
| [T3 Env](#t3-env) | env-core 0.13 | ✅ | — | — |
| [Nuxt UI](#nuxt-ui) | 4.12 | ✅ | — | dropped |

The rest of the [list of tools that accept Standard Schema](https://standardschema.dev/schema#what-tools-frameworks-accept-spec-compliant-schemas) works the same way. Validation always runs this package's pipeline, coercion and defaults included; see [Validation](/validation) for what that does to incoming values.

## Server frameworks

### Elysia

Elysia accepts Standard Schema for every validator slot, and checks the response too.

```ts
import { Elysia } from 'elysia'

new Elysia().post('/users', ({ body }) => createUser(body), {
  body: Type.Write(User), // body: { name: string, password: string }
  response: Type.Read(User), // a returned password is stripped
})
```

An invalid body is answered with `422` and the issues, each with its `path`. For OpenAPI output see [JSON Schema & OpenAPI](/json-schema).

### Hono

Use the official Standard Schema middleware, `@hono/standard-validator`:

```ts
import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'

const app = new Hono()

app.post('/users', sValidator('json', Type.Write(User)), (c) => {
  const user = c.req.valid('json') // { name: string, password: string }
  return c.json(createUser(user))
})
```

A failed check returns `400` with `{ success: false, error: issues, data }`. Hono echoes the rejected input in `data`, the password included; pass a hook as the third argument to `sValidator` if that shouldn't go back to the client.

### tRPC

```ts
import { initTRPC } from '@trpc/server'

const t = initTRPC.create()

export const router = t.router({
  createUser: t.procedure
    .input(Type.Write(User))
    .output(Type.Read(User))
    .mutation(({ input }) => createUser(input)),
})
```

tRPC puts only the first issue's message on the wire. To send every issue with its path, copy them from the error's cause in an `errorFormatter`:

```ts
const t = initTRPC.create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, issues: (error.cause as { issues?: unknown } | undefined)?.issues },
  }),
})
```

### oRPC

```ts
import { os } from '@orpc/server'

export const createUserProcedure = os
  .route({ method: 'POST', path: '/users' })
  .input(Type.Write(User))
  .output(Type.Read(User))
  .handler(({ input }) => createUser(input))
```

oRPC sends structured issues with paths in its `400` response out of the box.

### h3 and Nitro

h3 2.x validates with any Standard Schema; Nitro 3 builds on it.

```ts
import { H3, readValidatedBody } from 'h3'

const app = new H3()

app.post('/users', async (event) => {
  const user = await readValidatedBody(event, Type.Write(User))
  return createUser(user)
})
```

`getValidatedQuery` and `defineValidatedHandler({ validate: { body } })` take the same schemas. Failures come back as `400` with the issues in `data.issues`.

### Fastify

Fastify doesn't take Standard Schema natively: it takes JSON Schema and compiles it with Ajv. The schemas here are JSON Schema, so they work there too, including with `@fastify/type-provider-typebox` and `@fastify/swagger`:

```ts
app.post('/users', {
  schema: { body: Type.Write(User), response: { 200: Type.Read(User) } },
}, handler)
```

On that path Ajv validates, not this package. Ajv treats `readOnly` and `writeOnly` as annotations, so a client-sent `id` reaches the handler, and Fastify's own coercion rules apply. To get the projection strip, either call [`parse`](/validation#targets-and-parse) in the handler, or register the community plugin `fastify-standard-schema`, which routes validation through `~standard`.

## Forms and full-stack frameworks

### SvelteKit remote functions

`query`, `command` and `form` accept a Standard Schema:

```ts
// user.remote.ts
import { command, form, query } from '$app/server'

const CreateUser = Type.Write(User)

export const createUser = command(CreateUser, async (user) => save(user))
export const submitUser = form(CreateUser, async (user) => save(user))
```

Form fields arrive as strings; [coercion](/validation) turns `'42'` into `42` and `'true'` into `true` according to the schema, and every issue lands on its field. For `query` and `command`, SvelteKit answers an invalid argument with a bare `400` by design.

### TanStack Form

```tsx
const form = useForm({
  defaultValues: { name: '', password: '' },
  validators: { onChange: Type.Write(User) },
  onSubmit: ({ value }) => save(value),
})
```

Issues are routed to fields by their path. TanStack Form submits its own form state rather than the validated output, so a stray field in that state reaches `onSubmit`; validate again on the server with `parse`.

### TanStack Router

```ts
const Search = Type.Object({
  q: Type.String({ minLength: 1 }),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
})

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  validateSearch: Search,
})
```

Search params are coerced from the URL and defaults are filled in. The router keeps search params the schema doesn't declare in `match.search`.

### React Hook Form

Use the Standard Schema resolver from `@hookform/resolvers`:

```tsx
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'

const CreateUser = Type.Write(User)
type Input = StandardSchemaV1.InferInput<typeof CreateUser>
type Output = StandardSchemaV1.InferOutput<typeof CreateUser>

const { register, handleSubmit } = useForm<Input, unknown, Output>({
  resolver: standardSchemaResolver(CreateUser),
})
```

React Hook Form submits the resolver's output, so the strip and the coerced values reach your submit handler. A missing field gets its own error.

### next-safe-action

```ts
'use server'

export const createUser = actionClient
  .inputSchema(Type.Write(User))
  .action(async ({ parsedInput }) => save(parsedInput))
```

Issues come back in `validationErrors`, keyed by field.

### T3 Env

Each variable takes its own schema. Coercion parses the strings `process.env` holds, and an unset variable gets its default:

```ts
import { createEnv } from '@t3-oss/env-core'

export const env = createEnv({
  server: {
    DATABASE_URL: Type.String({ format: 'uri' }),
    PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
    DEBUG: Type.Boolean({ default: false }),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
```

### Nuxt UI

`<UForm>` takes the schema directly, and `@submit` receives the validated, stripped data:

```vue
<UForm :schema="CreateUser" :state="state" @submit="onSubmit">
  <UFormField name="name" label="Name"><UInput v-model="state.name" /></UFormField>
</UForm>
```
