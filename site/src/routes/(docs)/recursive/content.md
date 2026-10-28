# Recursive schemas

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
