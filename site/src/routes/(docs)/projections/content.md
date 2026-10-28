# Projections

Mark fields with `Type.Readonly` (output-only) and `Type.Writeonly` (input-only), then derive the input shape with `Type.Write` and the output shape with `Type.Read`. Both produce runtime schemas and static types, and they recurse through the whole tree: nested schemas, arrays, unions, intersections, `Type.Dependent` branches and `Type.Cyclic` definitions.

```ts
const User = Type.Object({
  id: Type.Readonly(Type.String()),
  email: Type.String({ format: 'email' }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
})

const CreateUser = Type.Write(User) // { email, password }
const PublicUser = Type.Read(User) // { id, email }
```

## Named projections

Options clone a projection into a standalone schema. `suffix` renames every `$id` in the tree — `'/user'` → `'/user/input'`, nested ids too — so read and write shapes get distinct names for doc generators. GraphQL-style naming works the same: `{ $id: 'User' }` + suffix `'Input'` → `'UserInput'`. Cyclic subtrees are renamed consistently (`$defs` keys, `$id`s and `$ref`s move together), so local resolution keeps working. Any other option overrides the root — an explicit `$id` wins over the suffixed one.

```ts
const UserInput = Type.Write(User, { suffix: '/input' }) // $id: '/user/input'
```

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
