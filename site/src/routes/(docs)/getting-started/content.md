# Getting started

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

Next: learn how [Projections](/projections) shape input and output, or how [Validation](/validation) works.
