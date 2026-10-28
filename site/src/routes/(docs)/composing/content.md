# Composing schemas

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
