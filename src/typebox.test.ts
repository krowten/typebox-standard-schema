import type { Static, TSchema, WithStandard } from './index'
import { describe, expect, test } from 'bun:test'
import { expectTypeOf } from 'expect-type'
import { adopt, parse, Type, validate } from './index'

// Covers the projection system: Readonly/Writeonly marks (runtime + types),
// Read/Write projections over self-contained trees (inline composition,
// arrays, unions, intersections, Cyclic), named projection options, adopt,
// and the ~standard surface.

// One entity with all three field kinds — reused across the tests below.
const Entity = Type.Object({
  id: Type.Readonly(Type.String()),
  createdAt: Type.Readonly(Type.String()),
  secret: Type.Writeonly(Type.String()),
  title: Type.String(),
  note: Type.Optional(Type.String()),
})

describe('field marks', () => {
  test('Type.Readonly replaces the built-in: sets the JSON keyword, not the TS modifier', () => {
    const marked = Type.Readonly(Type.String()) as unknown as Record<string, unknown>
    expect(marked.readOnly).toBe(true)
  })

  test('marks clone the inner schema instead of mutating a shared const', () => {
    const Email = Type.String({ format: 'email' })
    const marked = Type.Readonly(Email) as unknown as Record<string, unknown>
    expect(marked.readOnly).toBe(true)
    expect((Email as unknown as Record<string, unknown>).readOnly).toBeUndefined()
  })

  test('marking keeps typebox non-enumerable markers — an Optional stays optional', () => {
    // A plain spread would drop '~optional' and silently make the field required.
    const schema = Type.Object({
      note: Type.Readonly(Type.Optional(Type.String())),
      title: Type.String(),
    })

    expect((schema as unknown as { required: string[] }).required).toEqual(['title'])
    expect(validate(Type.Read(schema), { title: 't' }).success).toBe(true)
  })

  test('a marked field keeps its own constraints', () => {
    const schema = Type.Object({ secret: Type.Writeonly(Type.String({ minLength: 8 })) })

    expect(validate(schema, { secret: 'short' }).success).toBe(false)
    expect(validate(schema, { secret: 'longenough' }).success).toBe(true)
  })
})

describe('Type.Read / Type.Write', () => {
  test('write projection drops readOnly fields, read drops writeOnly', () => {
    const write = Type.Write(Entity) as unknown as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(write.properties).sort()).toEqual(['note', 'secret', 'title'])
    expect(write.required?.sort()).toEqual(['secret', 'title'])

    const read = Type.Read(Entity) as unknown as { properties: Record<string, unknown> }
    expect(Object.keys(read.properties).sort()).toEqual(['createdAt', 'id', 'note', 'title'])
  })

  test('projections are memoized (same object identity)', () => {
    expect(Type.Write(Entity)).toBe(Type.Write(Entity))
    expect(Type.Read(Entity)).toBe(Type.Read(Entity))
    expect(Type.Read(Entity)).not.toBe(Type.Write(Entity))
  })

  test('Static infers the correct types from projections', () => {
    const ReadSchema = Type.Read(Entity)
    const WriteSchema = Type.Write(Entity)

    // The real assertions are type-level (expectTypeOf fails under tsc, not
    // at runtime); the runtime expect only keeps bun:test from treating the
    // test as empty.
    expect(ReadSchema).toBeDefined()
    expect(WriteSchema).toBeDefined()

    expectTypeOf<Static<typeof ReadSchema>>().toEqualTypeOf<{
      id: string
      createdAt: string
      title: string
      note?: string
    }>()
    expectTypeOf<Static<typeof WriteSchema>>().toEqualTypeOf<{
      secret: string
      title: string
      note?: string
    }>()
  })

  test('validate() types its result as the shape it actually checked', () => {
    // A full schema is checked against its write projection, so the readOnly
    // fields are gone from the result — the type says so too.
    const full = validate(Entity, { secret: 's', title: 't' })
    expect(full.success).toBe(true)
    if (full.success) {
      expectTypeOf(full.data).toEqualTypeOf<{
        secret: string
        title: string
        note?: string
      }>()
    }

    // A projection is checked as itself, so the type is left alone.
    const read = validate(Type.Read(Entity), { id: '1', createdAt: 'x', title: 't' })
    expect(read.success).toBe(true)
    if (read.success) {
      expectTypeOf(read.data).toEqualTypeOf<{
        id: string
        createdAt: string
        title: string
        note?: string
      }>()
    }
  })

  test('a full schema validates against its write projection', () => {
    // Without readOnly id/createdAt — valid; without writeOnly secret — not.
    expect(validate(Entity, { secret: 's', title: 't' }).success).toBe(true)
    expect(validate(Entity, { title: 't' }).success).toBe(false)
  })

  test('a read projection validates against its own shape', () => {
    const read = Type.Read(Entity)
    expect(validate(read, { id: '1', createdAt: 'x', title: 't' }).success).toBe(true)
    expect(validate(read, { title: 't' }).success).toBe(false) // id/createdAt required
  })
})

describe('inline composition', () => {
  const User = Type.Object({
    id: Type.Readonly(Type.String()),
    name: Type.String(),
    password: Type.Writeonly(Type.String()),
  }, { $id: '/user' })

  const Post = Type.Object({
    title: Type.String(),
    author: User, // by value — the tree is self-contained
  }, { $id: '/post' })

  test('projections recurse into nested schemas', () => {
    const write = Type.Write(Post) as unknown as {
      properties: { author: { $id: string, properties: Record<string, unknown> } }
    }
    expect(Object.keys(write.properties.author.properties).sort()).toEqual(['name', 'password'])
    // $id survives projection — doc generators can still extract components.
    expect(write.properties.author.$id).toBe('/user')

    const read = Type.Read(Post) as unknown as {
      properties: { author: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(read.properties.author.properties).sort()).toEqual(['id', 'name'])
  })

  test('static types recurse into nested schemas', () => {
    const PostWrite = Type.Write(Post)
    expect(PostWrite).toBeDefined()
    expectTypeOf<Static<typeof PostWrite>>().toEqualTypeOf<{
      title: string
      author: { name: string, password: string }
    }>()
  })

  test('validation cuts marked fields at any depth', () => {
    expect(validate(Post, { title: 't', author: { name: 'n', password: 'p' } }).success).toBe(true)
    expect(validate(Post, { title: 't', author: { name: 'n' } }).success).toBe(false)
  })
})

describe('projections recurse into arrays, unions and intersections', () => {
  const Item = Type.Object({
    id: Type.Readonly(Type.String()),
    secret: Type.Writeonly(Type.String()),
    label: Type.String(),
  })

  test('array items', () => {
    const List = Type.Object({ items: Type.Array(Item) })
    const write = Type.Write(List) as unknown as {
      properties: { items: { items: { properties: Record<string, unknown> } } }
    }
    expect(Object.keys(write.properties.items.items.properties).sort()).toEqual([
      'label',
      'secret',
    ])
    expect(validate(List, { items: [{ secret: 's', label: 'a' }] }).success).toBe(true)
    expect(validate(List, { items: [{ label: 'a' }] }).success).toBe(false)
  })

  test('union (anyOf)', () => {
    const UnionWrite = Type.Write(Type.Union([Item]))
    const write = UnionWrite as unknown as {
      anyOf: { properties: Record<string, unknown> }[]
    }
    expect(Object.keys(write.anyOf[0]!.properties).sort()).toEqual(['label', 'secret'])

    // R04: the static type used to pass every union member through
    // unprojected, so `parse(Union, ...).id` compiled even though the
    // runtime write projection had already cut the readOnly `id` field.
    expectTypeOf<Static<typeof UnionWrite>>().toEqualTypeOf<{ secret: string, label: string }>()
  })

  test('a union with a non-object member only projects the branches that have fields', () => {
    const WithNull = Type.Write(Type.Union([Item, Type.Null()]))

    expect(validate(WithNull, null).success).toBe(true)
    expectTypeOf<Static<typeof WithNull>>().toEqualTypeOf<{ secret: string, label: string } | null>()
  })

  test('intersection (allOf)', () => {
    const IntersectRead = Type.Read(Type.Intersect([Item]))
    const read = IntersectRead as unknown as {
      allOf: { properties: Record<string, unknown> }[]
    }
    expect(Object.keys(read.allOf[0]!.properties).sort()).toEqual(['id', 'label'])

    expectTypeOf<Static<typeof IntersectRead>>().toEqualTypeOf<{ id: string, label: string }>()
  })

  test('tuple members (items is an array here, not a single schema)', () => {
    const Pair = Type.Tuple([Item, Type.String()])
    const write = Type.Write(Pair) as unknown as {
      items: [{ properties: Record<string, unknown> }, { type: string }]
    }
    expect(Object.keys(write.items[0].properties).sort()).toEqual(['label', 'secret'])
    expect(write.items[1].type).toBe('string')

    expect(validate(Pair, [{ secret: 's', label: 'a' }, 'x']).success).toBe(true)
    expect(validate(Pair, [{ label: 'a' }, 'x']).success).toBe(false)

    const PairWrite = Type.Write(Pair)
    expect(PairWrite).toBeDefined()
    expectTypeOf<Static<typeof PairWrite>>().toEqualTypeOf<[
      { secret: string, label: string },
      string,
    ]>()
  })

  test('optional and rest tuple members keep their kind', () => {
    const Pair = Type.Tuple([Type.String(), Type.Optional(Item)])
    const write = Type.Write(Pair) as unknown as { items: [unknown, { properties: Record<string, unknown> }] }
    expect(Object.keys(write.items[1].properties).sort()).toEqual(['label', 'secret'])

    const PairWrite = Type.Write(Pair)
    expect(PairWrite).toBeDefined()
    expectTypeOf<Static<typeof PairWrite>>().toEqualTypeOf<[
      string,
      { secret: string, label: string }?,
    ]>()

    const List = Type.Tuple([Type.String(), Type.Rest(Type.Array(Item))])
    const listWrite = Type.Write(List)
    expect(listWrite).toBeDefined()
    expectTypeOf<Static<typeof listWrite>>().toEqualTypeOf<[
      string,
      ...{ secret: string, label: string }[],
    ]>()
  })

  test('negations are left alone — cutting fields inside `not` would invert it', () => {
    // typebox 1.x has no Type.Not; a `not` can only arrive through adopt().
    const Negated = adopt<TSchema>({
      allOf: [
        { type: 'object', properties: { pub: { type: 'string' } } },
        {
          not: {
            type: 'object',
            required: ['secret'],
            properties: { secret: { type: 'string', writeOnly: true } },
          },
        },
      ],
    } as unknown as TSchema)

    const read = Type.Read(Negated) as unknown as { allOf: [unknown, { not: { required: string[] } }] }
    expect(read.allOf[1].not.required).toEqual(['secret'])
    // "must not be an object carrying a secret" — an object without one passes.
    expect(validate(read, { pub: 'p' }).success).toBe(true)
    expect(validate(read, { pub: 'p', secret: 's' }).success).toBe(false)
  })

  test('a property named after an Object.prototype member is dropped properly', () => {
    const Weird = Type.Object({
      constructor: Type.Readonly(Type.String()),
      ok: Type.String(),
    })

    expect((Type.Write(Weird) as unknown as { required: string[] }).required).toEqual(['ok'])
    expect(validate(Weird, { ok: 'x' }).success).toBe(true)
  })

  test('record values (patternProperties)', () => {
    const Dict = Type.Record(Type.String(), Item)
    const read = Type.Read(Dict) as unknown as {
      patternProperties: Record<string, { properties: Record<string, unknown> }>
    }
    const [pattern, value] = Object.entries(read.patternProperties)[0]!
    // The pattern key is a regex — it is never renamed or filtered.
    expect(pattern).toBe('^.*$')
    expect(Object.keys(value.properties).sort()).toEqual(['id', 'label'])

    expect(validate(Dict, { a: { secret: 's', label: 'l' } }).success).toBe(true)
    expect(validate(Dict, { a: { label: 'l' } }).success).toBe(false)

    const DictRead = Type.Read(Dict)
    expect(DictRead).toBeDefined()
    expectTypeOf<Static<typeof DictRead>>().toEqualTypeOf<Record<string, {
      id: string
      label: string
    }>>()
  })
})

describe('Type.Cyclic (recursive schemas)', () => {
  const Tree = Type.Cyclic({
    Node: Type.Object({
      value: Type.String(),
      secret: Type.Writeonly(Type.String()),
      children: Type.Array(Type.Ref('Node')),
    }),
  }, 'Node')

  test('validates a recursive structure', () => {
    const sample = {
      value: 'root',
      secret: 's',
      children: [{ value: 'leaf', secret: 's2', children: [] }],
    }
    expect(validate(Tree, sample).success).toBe(true)
    expect(validate(Tree, { value: 'root', children: [{ children: [] }] }).success).toBe(false)
  })

  test('static inference works through the cycle', () => {
    type T = Static<typeof Tree>
    const sample: T = { value: 'root', secret: 's', children: [{ value: 'leaf', secret: 's', children: [] }] }
    expect(sample.children[0]?.value).toBe('leaf')
  })

  test('projections cut marked fields inside $defs', () => {
    const read = Type.Read(Tree) as unknown as {
      $defs: { Node: { properties: Record<string, unknown>, required: string[] } }
    }
    expect(Object.keys(read.$defs.Node.properties).sort()).toEqual(['children', 'value'])
    expect(read.$defs.Node.required.sort()).toEqual(['children', 'value'])

    // Runtime: the read shape accepts a tree without writeOnly secrets.
    const readSample = { value: 'root', children: [{ value: 'leaf', children: [] }] }
    expect(validate(Type.Read(Tree), readSample).success).toBe(true)
  })

  test('~standard validates the recursive write shape', () => {
    const result = Tree['~standard'].validate({ value: 'root', secret: 's', children: [] })
    expect(result).toHaveProperty('value')
  })
})

describe('named projections — suffix', () => {
  const Profile = Type.Object({
    bio: Type.String(),
    views: Type.Readonly(Type.Number()),
  }, { $id: '/user/profile' })

  const User = Type.Object({
    id: Type.Readonly(Type.String()),
    name: Type.String(),
    profile: Profile,
  }, { $id: '/user' })

  test('appends the suffix to every $id in the tree', () => {
    const input = Type.Write(User, { suffix: '/input' }) as unknown as {
      $id: string
      properties: { profile: { $id: string } }
      suffix?: unknown
    }
    expect(input.$id).toBe('/user/input')
    expect(input.properties.profile.$id).toBe('/user/profile/input')
    // The suffix option itself never lands in the schema JSON.
    expect(input.suffix).toBeUndefined()
  })

  test('GraphQL-style naming works the same way', () => {
    const Account = Type.Object({ name: Type.String() }, { $id: 'Account' })
    const input = Type.Write(Account, { suffix: 'Input' }) as unknown as { $id: string }
    expect(input.$id).toBe('AccountInput')
  })

  test('an explicit $id override wins over the suffixed root, children keep the suffix', () => {
    const named = Type.Read(User, { suffix: '/output', $id: '/public-user' }) as unknown as {
      $id: string
      properties: { profile: { $id: string } }
    }
    expect(named.$id).toBe('/public-user')
    expect(named.properties.profile.$id).toBe('/user/profile/output')
  })

  test('does not mutate the memoized anonymous projection', () => {
    Type.Write(User, { suffix: '/input' })
    expect((Type.Write(User) as unknown as { $id: string }).$id).toBe('/user')
  })

  test('suffixed projection still validates as its shape', () => {
    const input = Type.Write(User, { suffix: '/in' })
    expect(validate(input, { name: 'n', profile: { bio: 'b' } }).success).toBe(true)
    expect(validate(input, { name: 'n' }).success).toBe(false)
  })

  test('suffixes $ids nested in arrays and unions too', () => {
    const Tag = Type.Object({ name: Type.String() }, { $id: '/tag' })
    const Box = Type.Object({
      tags: Type.Array(Tag),
      either: Type.Union([Tag, Type.String()]),
    }, { $id: '/box' })

    const output = Type.Read(Box, { suffix: '/output' }) as unknown as {
      $id: string
      properties: {
        tags: { items: { $id: string } }
        either: { anyOf: { $id?: string }[] }
      }
    }
    expect(output.$id).toBe('/box/output')
    expect(output.properties.tags.items.$id).toBe('/tag/output')
    expect(output.properties.either.anyOf[0]?.$id).toBe('/tag/output')
    // The source tree is left alone.
    expect((Tag as unknown as { $id: string }).$id).toBe('/tag')
  })

  test('a $ref that does not point at a local definition is left alone', () => {
    const Tree = Type.Cyclic({
      Node: Type.Object({ children: Type.Array(Type.Ref('Node')) }),
    }, 'Node')

    const suffixed = Type.Read(Tree, { suffix: 'X' }) as unknown as {
      $defs: Record<string, { properties: { children: { items: { $ref: string } } } }>
    }
    expect(suffixed.$defs.NodeX?.properties.children.items.$ref).toBe('NodeX')
  })

  test('Cyclic subtrees are renamed consistently and keep resolving', () => {
    const Tree = Type.Cyclic({
      TreeNode: Type.Object({
        value: Type.String(),
        stamp: Type.Readonly(Type.String()),
        children: Type.Array(Type.Ref('TreeNode')),
      }),
    }, 'TreeNode')

    const input = Type.Write(Tree, { suffix: 'Input' }) as unknown as {
      $ref: string
      $defs: Record<string, { $id: string, properties: Record<string, unknown> }>
    }
    // $defs key, its $id and every $ref move together.
    expect(Object.keys(input.$defs)).toEqual(['TreeNodeInput'])
    expect(input.$defs.TreeNodeInput?.$id).toBe('TreeNodeInput')
    expect(input.$ref).toBe('TreeNodeInput')
    // readOnly stamp is cut inside the definition, and the schema still compiles.
    expect(Object.keys(input.$defs.TreeNodeInput!.properties).sort()).toEqual(['children', 'value'])
    const sample = { value: 'root', children: [{ value: 'leaf', children: [] }] }
    expect(validate(input as unknown as TSchema, sample).success).toBe(true)
    expect(validate(input as unknown as TSchema, { children: [] }).success).toBe(false)
  })
})

describe('named projections', () => {
  test('options are applied to a cloned standalone schema', () => {
    const CreateEntity = Type.Write(Entity, { $id: '/entity/create', description: 'input shape' })

    const c = CreateEntity as unknown as { $id: string, description: string }
    expect(c.$id).toBe('/entity/create')
    expect(c.description).toBe('input shape')

    // Still validates as a write shape by itself.
    expect(validate(CreateEntity, { secret: 's', title: 't' }).success).toBe(true)
    expect(validate(CreateEntity, { title: 't' }).success).toBe(false)

    // The memoized anonymous projection is untouched by the clone.
    expect((Type.Write(Entity) as unknown as { $id?: string }).$id).toBeUndefined()
  })
})

describe('adopt', () => {
  test('brings an externally-built schema into ~standard', () => {
    // Simulates a schema NOT built via our Type builder (e.g. drizzle-typebox
    // output): plain JSON Schema.
    const raw: TSchema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    }
    const External = adopt(raw)

    expect(typeof External['~standard']).toBe('object')
    expect(validate(External, { x: 'ok' }).success).toBe(true)
    expect(External['~standard'].validate({ x: 'ok' })).toHaveProperty('value')
  })

  test('adopts in place and is idempotent', () => {
    const raw: TSchema = { type: 'string' }
    const adopted = adopt(raw)

    expect(adopted as TSchema).toBe(raw)
    expect(adopt(raw)['~standard']).toBe(adopted['~standard'])
    expect(Object.keys(raw)).toEqual(['type'])
  })

  test('leaves an interface from another vendor in place', () => {
    const foreign = { type: 'string' } as unknown as TSchema
    const theirs = { version: 1, vendor: 'elsewhere', validate: () => ({ value: 'x' }) }
    // Non-configurable, as a vendor attaching it once would define it.
    Object.defineProperty(foreign, '~standard', { value: theirs, enumerable: false })

    expect(() => adopt(foreign)).not.toThrow()
    expect((foreign as unknown as { '~standard': unknown })['~standard']).toBe(theirs)
  })

  test('projections of an adopted schema work like any other', () => {
    const External = adopt<TSchema>({
      type: 'object',
      properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } },
      required: ['id', 'name'],
    })

    const write = Type.Write(External) as unknown as { properties: Record<string, unknown> }
    expect(Object.keys(write.properties)).toEqual(['name'])
    expect(validate(External, { name: 'n' }).success).toBe(true)
  })

  // R12: `WithStandard<T>` used to attach `StandardProps` with no generic,
  // defaulting `types.output` to `unknown` regardless of what `T` actually
  // was — a Standard Schema consumer (tRPC, Hono, a remote-function handler)
  // got an untyped argument for any adopted schema, drizzle-typebox included.
  // `Static<T>` (typebox 1.x's own inference, applied directly to the
  // foreign T) fixes it — verified separately against a real
  // @sinclair/typebox 0.34 schema from drizzle-typebox, which is
  // structurally plain JSON Schema underneath, exactly what Static dispatches
  // on. The object literal below must NOT carry an explicit `TSchema`
  // annotation — that would widen T back to the same unknown-shape base type
  // this test is proving inference now avoids.
  test('the adopted schema keeps its own shape in ~standard.types (R12)', () => {
    const External = adopt({
      type: 'object',
      properties: { id: { type: 'string' }, age: { type: 'number' } },
      required: ['id', 'age'],
    } as const)

    expect(validate(External, { id: 'x', age: 1 }).success).toBe(true)

    type Output = NonNullable<typeof External['~standard']['types']>['output']
    expectTypeOf<Output>().not.toBeUnknown()
    expectTypeOf<Output>().toEqualTypeOf<{ id: string, age: number }>()
  })
})

describe('~standard', () => {
  test('is attached to schemas and validates against the write projection', () => {
    const std = Entity['~standard']
    expect(std?.version).toBe(1)

    const ok = std.validate({ secret: 's', title: 't' }) as { value?: unknown }
    expect(ok.value).toEqual({ secret: 's', title: 't' })

    const bad = std.validate({ title: 't' }) as { issues?: unknown[] }
    expect(bad.issues?.length).toBeGreaterThan(0)
  })

  test('is the same object on every read of the same schema', () => {
    const first = Type.Write(Entity)
    const second = Type.Write(Entity)

    expect(second).toBe(first)
    expect(second['~standard']).toBe(first['~standard'])
  })

  // Every clone — projections, marks, named copies — inherits the ~standard
  // property from the schema it was cloned off. It has to bind to the object it
  // is read from, or a projection would hand Standard Schema consumers (tRPC,
  // Hono, TanStack Form) the validation shape of its source.
  test('a projection validates its own shape, not its source', () => {
    const read = Type.Read(Entity)

    expect(read['~standard'].validate({ id: '1', createdAt: 'x', title: 't' })).toHaveProperty('value')

    // The result is a properly discriminated union now — no cast needed.
    const missingId = read['~standard'].validate({ title: 't' })
    expect('issues' in missingId && missingId.issues.map(i => i.path)).toEqual([['id'], ['createdAt']])
  })

  test('projected nodes nested in a projection do too', () => {
    const Post = Type.Object({ author: Entity })
    const author = (Type.Read(Post) as unknown as {
      properties: { author: WithStandard<TSchema> }
    }).properties.author

    expect(author['~standard'].validate({ id: '1', createdAt: 'x', title: 't' })).toHaveProperty('value')
    expect(author['~standard'].validate({ secret: 's', title: 't' })).toHaveProperty('issues')
  })

  test('a named projection validates its own shape', () => {
    const CreateEntity = Type.Write(Entity, { $id: '/entity/create' })

    expect(CreateEntity['~standard'].validate({ secret: 's', title: 't' })).toHaveProperty('value')
    expect(CreateEntity['~standard'].validate({ id: '1', title: 't' })).toHaveProperty('issues')
  })

  test('a marked schema keeps a working interface of its own', () => {
    const Secret = Type.Writeonly(Type.String({ minLength: 8 }))

    expect(Secret['~standard'].validate('longenough')).toHaveProperty('value')
    expect(Secret['~standard'].validate('short')).toHaveProperty('issues')
  })
})

describe('custom types — Type.Unsafe', () => {
  test('builds a custom schema that validates and carries ~standard', () => {
    // A custom node: plain JSON Schema the engine understands, static type via the generic.
    const Celsius = Type.Unsafe<number>({ type: 'number', minimum: -273.15 })

    expect(Celsius['~standard']?.version).toBe(1)
    expect(validate(Celsius, 20).success).toBe(true)
    expect(validate(Celsius, -300).success).toBe(false)

    const schema = Type.Object({ temp: Celsius })
    const result = validate(schema, { temp: 36.6 })
    expect(result).toEqual({ success: true, data: { temp: 36.6 } })

    expectTypeOf<Static<typeof Celsius>>().toEqualTypeOf<number>()
  })
})

describe('Type builder — bundle safety', () => {
  // typebox's default export is a module namespace. A Rollup production bundle
  // freezes it, making factory properties non-writable + non-configurable. A
  // Proxy whose get trap returns wrapped factories then violates the Proxy
  // invariant at runtime ("'get' on proxy: property 'String' is read-only and
  // non-configurable data property"). dev/bun tolerate it (props stay writable
  // there), prod crashes. Type must own its factories as plain, configurable
  // data properties, decoupled from the source namespace's descriptors.
  test('exposes factories as configurable own properties, not a proxy over the namespace', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Type, 'String')

    expect(descriptor?.configurable).toBe(true)
  })

  test('factories still build ~standard-carrying schemas', () => {
    const schema = Type.String()

    expect(schema['~standard']?.version).toBe(1)
  })

  test('non-factory members of typebox are carried over untouched', () => {
    expect(Type.ExtendsResult).toBeDefined()
  })

  test('Type.Ref passes through and only resolves inside Cyclic definitions', () => {
    const ref = Type.Ref('Node') as unknown as { $ref: string }

    expect(ref.$ref).toBe('Node')
    expect(Object.keys(ref)).toEqual(['$ref'])
  })
})

describe('~standard survives typebox\'s own internal cloning (R03)', () => {
  test('Type.Optional wrapping a read projection keeps validating as read', () => {
    const ReadId = Type.Read(Type.Object({ id: Type.Readonly(Type.String()) }))

    // typebox clones the wrapped schema internally when adding '~optional';
    // that clone must still carry the read mode, not fall back to deriving
    // a fresh write projection (which would demand different fields).
    expect(validate(Type.Optional(ReadId), {}).success).toBe(false)
    expect(validate(Type.Optional(ReadId), { id: '1' }).success).toBe(true)
  })

  test('a property nested inside Type.Partial keeps a working ~standard', () => {
    const Partial = Type.Partial(Type.Object({ name: Type.String() }))
    const name = (Partial as unknown as { properties: { name: WithStandard<TSchema> } }).properties.name

    expect(typeof name['~standard']?.validate).toBe('function')
    expect(name['~standard'].validate('n')).toHaveProperty('value', 'n')
  })
})

describe('Type.Partial supports unions (R05/R06)', () => {
  test('Partial(Union) does not crash and validates an empty update', () => {
    const S = Type.Partial(Type.Union([
      Type.Object({ a: Type.String() }),
      Type.Object({ b: Type.String() }),
    ]))

    expect(validate(S, {}).success).toBe(true)
  })

  test('a default hidden inside a union branch is not materialized for an absent field', () => {
    const S = Type.Partial(Type.Object({
      status: Type.Union([Type.String({ default: 'draft' }), Type.Number()]),
    }))

    expect(parse(S, {})).toEqual({})
  })

  test('a default on the union node itself is still stripped (not just branch defaults)', () => {
    const S = Type.Partial(Type.Object({
      status: Type.Union([Type.Literal('draft'), Type.Literal('published')], { default: 'draft' }),
    }))

    expect(parse(S, {})).toEqual({})
  })

  test('an explicit nested value is unaffected — Partial stays shallow', () => {
    const S = Type.Partial(Type.Object({
      title: Type.String(),
      status: Type.Union([Type.Literal('draft'), Type.Literal('published')], { default: 'draft' }),
    }))

    expect(parse(S, { status: 'published' })).toEqual({ status: 'published' })
  })
})

describe('Type.Codec keeps its builder chain (R07)', () => {
  test('Decode/Encode remain callable and the finished codec carries ~standard', () => {
    const Codec = Type.Codec(Type.String()).Decode(v => v.length).Encode(v => String(v))

    expect(typeof (Codec as unknown as { '~kind': string })['~kind']).toBe('string')
    expect(Codec['~standard']?.version).toBe(1)
  })
})

describe('a schema property named __proto__ survives projection (R10)', () => {
  test('the property and its required-ness are preserved', () => {
    // A quoted `'__proto__'` key in an object literal sets the prototype,
    // not an own property — the computed form is required to actually get
    // one, which is exactly the case this test needs to exercise.
    const S = Type.Object({ ['__proto__']: Type.String(), id: Type.Readonly(Type.String()) })
    const Written = Type.Write(S) as unknown as { properties: object }

    expect(Object.hasOwn(Written.properties, '__proto__')).toBe(true)
    expect(validate(S, {}).success).toBe(false)
  })
})

describe('Type.Dependent (if/then/else) is projected and typed (R11)', () => {
  test('the then branch participates in validation', () => {
    const S = Type.Dependent(
      Type.Object({ kind: Type.Literal('x') }),
      Type.Object({ id: Type.Readonly(Type.String()), name: Type.String() }),
      Type.Object({ name: Type.String() }),
    )

    expect(validate(S, { kind: 'x', name: 'n' }).success).toBe(true)
  })

  test('carries ~standard and type-checks as a Standard Schema', () => {
    const S = Type.Dependent(
      Type.Object({ kind: Type.Literal('x') }),
      Type.Object({ name: Type.String() }),
      Type.Object({ name: Type.String() }),
    )

    expect(S['~standard']?.version).toBe(1)
  })

  test('a read projection drops a writeOnly field inside a branch from the static type too', () => {
    const S = Type.Dependent(
      Type.Object({ kind: Type.Literal('x') }),
      Type.Object({ kind: Type.Literal('x'), secret: Type.Writeonly(Type.String()) }),
      Type.Object({ name: Type.String() }),
    )
    const ReadS = Type.Read(S)

    expectTypeOf<Extract<Static<typeof ReadS>, { kind: 'x' }>>().toEqualTypeOf<{ kind: 'x' }>()
    expect(parse(ReadS, { kind: 'x', secret: 's' })).toEqual({ kind: 'x' })
  })

  test('a field marked in `if` is gone from the static read type, as from the data', () => {
    const S = Type.Dependent(
      Type.Object({ password: Type.Writeonly(Type.String()) }),
      Type.Object({ kind: Type.Literal('local') }),
      Type.Object({ kind: Type.Literal('sso') }),
    )
    const ReadS = Type.Read(S)

    expectTypeOf<keyof Extract<Static<typeof ReadS>, { kind: 'local' }>>().toEqualTypeOf<'kind'>()
    expect(parse(ReadS, { password: 'p', kind: 'local' })).toEqual({ kind: 'local' })
  })
})

describe('reshaping a projection keeps it a projection, statically too', () => {
  const User = Type.Object({
    id: Type.Readonly(Type.String()),
    email: Type.String(),
    password: Type.Writeonly(Type.String()),
  })

  test('Type.Partial(Type.Read(User)) validates, and is typed, as a read shape', () => {
    const result = validate(Type.Partial(Type.Read(User)), { id: '1', password: 'p' })

    expect(result).toEqual({ success: true, data: { id: '1' } })
    if (result.success)
      expectTypeOf(result.data).toEqualTypeOf<{ id?: string, email?: string }>()
  })

  test('Type.Pick/Type.Omit of a read projection keep readOnly fields', () => {
    const picked = validate(Type.Pick(Type.Read(User), ['id']), { id: '1' })
    const omitted = validate(Type.Omit(Type.Read(User), ['email']), { id: '1' })

    expect(picked).toEqual({ success: true, data: { id: '1' } })
    expect(omitted).toEqual({ success: true, data: { id: '1' } })
    if (picked.success)
      expectTypeOf(picked.data).toEqualTypeOf<{ id: string }>()
    if (omitted.success)
      expectTypeOf(omitted.data).toEqualTypeOf<{ id: string }>()
  })
})

describe('suffix renames refs under not/if without changing what validates (R14)', () => {
  test('a forbidden value under a renamed local ref is still forbidden', () => {
    const S = Type.Cyclic(
      { Node: Type.String(), Forbidden: Type.Literal('no') },
      'Node',
      { not: { $ref: 'Forbidden' } },
    )

    expect(validate(S, 'no').success).toBe(false)
    expect(validate(Type.Write(S, { suffix: 'Input' }), 'no').success).toBe(false)
    expect(validate(Type.Write(S, { suffix: 'Input' }), 'yes').success).toBe(true)
  })
})

describe('static projection of an intersection cuts a key from every member', () => {
  test('a key one member marks is gone from the read type', () => {
    const S = Type.Intersect([Type.Object({ a: Type.String(), note: Type.Writeonly(Type.String()) }), Type.Object({ note: Type.String() })])
    const Read = Type.Read(S)

    expectTypeOf<keyof Static<typeof Read>>().toEqualTypeOf<'a'>()
    expect(parse(Read, { a: 'x', note: 'n' })).toEqual({ a: 'x' })
  })
})
