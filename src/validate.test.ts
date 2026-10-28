import type { TSchema } from './index'
import { describe, expect, test } from 'bun:test'
import { expectTypeOf } from 'expect-type'
import { adopt, Format, isValidationError, parse, Type, validate, Value } from './index'

describe('validate — TypeBox as a Standard Schema', () => {
  test('returns value for valid data', () => {
    const schema = Type.Object({ id: Type.String() })
    const result = validate(schema, { id: 'abc' })

    expect(result).toEqual({ success: true, data: { id: 'abc' } })
  })

  test('coerces FormData string values to schema types', () => {
    const schema = Type.Object({ n: Type.Number() })
    const result = validate(schema, { n: '42' })

    expect(result).toEqual({ success: true, data: { n: 42 } })
  })

  test('does not mutate the input object while coercing', () => {
    const schema = Type.Object({ n: Type.Number() })
    const input = { n: '42' }
    validate(schema, input)

    expect(input).toEqual({ n: '42' })
  })

  test('validates a union of literals (locale-style)', () => {
    const schema = Type.Union([Type.Literal('en'), Type.Literal('ru')])

    expect(validate(schema, 'en')).toEqual({ success: true, data: 'en' })
    expect(validate(schema, 'fr').success).toBe(false)
  })

  test('returns errors with the field path for a missing property', () => {
    const schema = Type.Object({ id: Type.String() })
    const result = validate(schema, { wrong: true })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0]?.keyword).toBe('required')
      expect(result.errors[0]?.path).toEqual(['id'])
    }
  })

  test('checks format email and reports keyword + format', () => {
    const schema = Type.Object({ email: Type.String({ format: 'email' }) })
    const result = validate(schema, { email: 'not-an-email' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0]?.keyword).toBe('format')
      expect(result.errors[0]?.params).toEqual({ format: 'email' })
      expect(result.errors[0]?.path).toEqual(['email'])
    }
  })

  test('reports the path for nested fields', () => {
    const schema = Type.Object({ info: Type.Object({ height: Type.Number() }) })
    const result = validate(schema, { info: { height: 'tall' } })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0]?.path).toEqual(['info', 'height'])
    }
  })

  test('checks minLength and reports keyword + limit', () => {
    const schema = Type.Object({
      password: Type.String({ minLength: 8 }),
    })
    const result = validate(schema, { password: 'short' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0]?.keyword).toBe('minLength')
      expect(result.errors[0]?.params).toEqual({ limit: 8 })
      expect(result.errors[0]?.path).toEqual(['password'])
    }
  })

  test('checks pattern and reports keyword pattern (not minLength)', () => {
    const schema = Type.Object({
      password: Type.String({ minLength: 8, pattern: '(?=.*[A-Z])' }),
    })
    const errors = validate(schema, { password: 'short' })
    expect(errors.success).toBe(false)
    if (!errors.success) {
      const keywords = errors.errors.map(e => e.keyword)
      expect(keywords).toContain('minLength')
      expect(keywords).toContain('pattern')
      const patternErr = errors.errors.find(e => e.keyword === 'pattern')!
      expect(patternErr.params).toHaveProperty('pattern')
    }
  })

  test('applies defaults', () => {
    const schema = Type.Object({
      page: Type.Optional(Type.Integer({ default: 1 })),
    })
    const result = validate(schema, {})

    expect(result).toEqual({ success: true, data: { page: 1 } })
  })

  test('Type.Partial does not inject defaults for absent fields', () => {
    const schema = Type.Object({
      title: Type.String(),
      status: Type.Union([Type.Literal('draft'), Type.Literal('published')], { default: 'draft' }),
    })
    const result = validate(Type.Partial(schema), { title: 'hi' })

    expect(result).toEqual({ success: true, data: { title: 'hi' } })
  })

  test('Type.Partial leaves the source schema defaults intact', () => {
    const schema = Type.Object({
      status: Type.String({ default: 'draft' }),
    })
    Type.Partial(schema)

    expect((schema.properties.status as { default?: unknown }).default).toBe('draft')
    expect(validate(schema, {})).toEqual({ success: true, data: { status: 'draft' } })
  })

  test('Type.Partial result carries ~standard', () => {
    const schema = Type.Object({ id: Type.String() })
    const partial = Type.Partial(schema)

    expect(partial['~standard']?.version).toBe(1)
    expect(partial['~standard'].validate({})).toHaveProperty('value', {})
  })

  test('custom formats registered via Format are enforced', () => {
    Format.Set('hex-color', v => /^#[0-9a-f]{6}$/i.test(v))
    const schema = Type.Object({ color: Type.String({ format: 'hex-color' }) })

    expect(validate(schema, { color: '#ff8800' })).toEqual({
      success: true,
      data: { color: '#ff8800' },
    })

    const bad = validate(schema, { color: 'red' })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      expect(bad.errors[0]?.keyword).toBe('format')
      expect(bad.errors[0]?.params).toEqual({ format: 'hex-color' })
      expect(bad.errors[0]?.path).toEqual(['color'])
    }
  })

  test('format registration also applies to already-compiled validators', () => {
    const schema = Type.Object({ v: Type.String({ format: 'late-format' }) })
    // Unknown formats are ignored (JSON Schema semantics) — this call also JIT-compiles the schema.
    expect(validate(schema, { v: 'anything' }).success).toBe(true)

    Format.Set('late-format', v => v === 'ok')
    expect(validate(schema, { v: 'anything' }).success).toBe(false)
    expect(validate(schema, { v: 'ok' }).success).toBe(true)
  })

  test('replacing a format reaches validators compiled before the change', () => {
    Format.Set('swap-format', v => v === 'a')
    const schema = Type.Object({ v: Type.String({ format: 'swap-format' }) })
    expect(validate(schema, { v: 'b' }).success).toBe(false)

    Format.Set('swap-format', v => v === 'b')
    expect(validate(schema, { v: 'b' }).success).toBe(true)
    expect(validate(Type.Read(schema), { v: 'a' }).success).toBe(false)
  })

  test('injects ~standard into every schema the builder returns', () => {
    const schema = Type.Object({ id: Type.String() })

    expect(typeof schema['~standard']).toBe('object')
    expect(schema['~standard'].version).toBe(1)
    expect(schema['~standard'].vendor).toBe('typebox')
    expect(typeof schema['~standard'].validate).toBe('function')
  })

  test('~standard.validate returns value for valid data', () => {
    const schema = Type.Object({ id: Type.String() })
    const result = schema['~standard'].validate({ id: 'abc' })

    expect(result).toHaveProperty('value', { id: 'abc' })
  })

  test('~standard.validate returns issues for invalid data', () => {
    const schema = Type.Object({ id: Type.String() })
    const result = schema['~standard'].validate({ wrong: true })

    expect(result).toHaveProperty('issues')
    // The union is discriminated by the `issues` key, as the spec prescribes.
    if ('issues' in result)
      expect(result.issues[0]?.path).toEqual(['id'])
  })
})

describe('issue mapping', () => {
  test('reports array indexes as numeric path segments', () => {
    const schema = Type.Object({ xs: Type.Array(Type.Number()) })
    const result = validate(schema, { xs: [1, 'nope'] })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors[0]?.keyword).toBe('type')
      expect(result.errors[0]?.path).toEqual(['xs', 1])
    }
  })

  test('fans a multi-property required error out into one issue per field', () => {
    const schema = Type.Object({ a: Type.String(), b: Type.String() })
    const result = validate(schema, {})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors.map(e => e.path)).toEqual([['a'], ['b']])
      expect(result.errors.map(e => e.params)).toEqual([
        { missingProperty: 'a' },
        { missingProperty: 'b' },
      ])
      expect(result.errors.map(e => e.keyword)).toEqual(['required', 'required'])
    }
  })

  test('reports the index of the failing member for nested arrays of objects', () => {
    const schema = Type.Object({ items: Type.Array(Type.Object({ n: Type.Number() })) })
    const result = validate(schema, { items: [{ n: 1 }, { n: 'x' }] })

    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.errors[0]?.path).toEqual(['items', 1, 'n'])
  })

  // typebox escapes instancePath per RFC 6901 ('a/b' → 'a~1b', 'x~y' →
  // 'x~0y'); paths come back unescaped, one segment per key.
  test('a property named with a slash stays one path segment', () => {
    const schema = Type.Object({ 'a/b': Type.Number(), 'x~y': Type.Number() })
    const result = validate(schema, { 'a/b': 'no', 'x~y': 'no' })

    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.errors.map(e => e.path)).toEqual([['a/b'], ['x~y']])
  })

  test('a slash-named property is told apart from real nesting', () => {
    const schema = Type.Object({
      a: Type.Object({ b: Type.Number() }),
    })
    const result = validate(schema, { a: { b: 'no' } })

    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.errors[0]?.path).toEqual(['a', 'b'])
  })

  test('a slash-named key and real nesting side by side stay apart', () => {
    // Keys 'a/b' AND a.{b} in one value: the escaped pointer ('/a~1b' vs
    // '/a/b') names exactly one of them.
    const schema = Type.Object({
      'a/b': Type.Number(),
      'a': Type.Object({ b: Type.String() }),
    })
    const flat = validate(schema, { 'a/b': 'not-a-number', 'a': { b: 'fine' } })
    const nested = validate(schema, { 'a/b': 1, 'a': { b: {} } })

    expect(flat.success || flat.errors.map(e => e.path)).toEqual([['a/b']])
    expect(nested.success || nested.errors.map(e => e.path)).toEqual([['a', 'b']])
  })

  test('a numeric key of an object stays a string, an array index becomes a number', () => {
    const inObject = validate(
      Type.Record(Type.String(), Type.Number()),
      { 42: 'no' },
    )
    expect(inObject.success).toBe(false)
    if (!inObject.success)
      expect(inObject.errors[0]?.path).toEqual(['42'])

    const inArray = validate(Type.Array(Type.Number()), [0, 'no'])
    expect(inArray.success).toBe(false)
    if (!inArray.success)
      expect(inArray.errors[0]?.path).toEqual([1])
  })
})

describe('validation pipeline', () => {
  test('validates primitive roots (nothing to clone)', () => {
    const schema = Type.String({ minLength: 2 })

    expect(validate(schema, 'ok')).toEqual({ success: true, data: 'ok' })
    expect(validate(schema, 'x').success).toBe(false)
  })

  test('coerces and defaults through nested objects and arrays', () => {
    const schema = Type.Object({
      page: Type.Object({
        index: Type.Number(),
        size: Type.Optional(Type.Integer({ default: 20 })),
      }),
      flags: Type.Array(Type.Boolean()),
    })

    expect(validate(schema, { page: { index: '2' }, flags: ['true', 'false'] })).toEqual({
      success: true,
      data: { page: { index: 2, size: 20 }, flags: [true, false] },
    })
  })

  test('leaves nested input objects untouched while coercing', () => {
    const schema = Type.Object({ page: Type.Object({ index: Type.Number() }) })
    const input = { page: { index: '2' } }
    validate(schema, input)

    expect(input).toEqual({ page: { index: '2' } })
  })

  test('a missing value gets its default before anything converts it', () => {
    expect(validate(Type.Integer({ default: 3000 }), undefined)).toEqual({ success: true, data: 3000 })
    expect(validate(Type.Object({ port: Type.Integer({ default: 3000 }) }), { port: undefined }))
      .toEqual({ success: true, data: { port: 3000 } })
  })

  test('defaults reach a Type.Cyclic nested in another one, at every level', () => {
    // A union branch Ref('N0') is checked in a context; typebox only resolves
    // the inner N1 there once it is lifted into that context.
    const S = Type.Cyclic({
      N0: Type.Object({
        inner: Type.Cyclic({ N1: Type.Object({ a: Type.String(), b: Type.Optional(Type.String({ default: 'd' })) }) }, 'N1'),
        next: Type.Optional(Type.Union([Type.Ref('N0'), Type.Null()])),
      }),
    }, 'N0')

    expect(validate(S, { inner: { a: 'x' }, next: { inner: { a: 'y' }, next: { inner: { a: 'z' } } } })).toEqual({
      success: true,
      data: { inner: { a: 'x', b: 'd' }, next: { inner: { a: 'y', b: 'd' }, next: { inner: { a: 'z', b: 'd' } } } },
    })
  })

  test('an explicitly undefined value is not converted into one', () => {
    // TypeBox's Convert alone would make these '' and 0 and let them pass.
    expect(validate(Type.String(), undefined).success).toBe(false)
    const required = validate(Type.Object({ name: Type.String(), age: Type.Number() }), { name: undefined, age: undefined })
    expect(required.success || required.errors.map(e => e.path)).toEqual([['name'], ['age']])
    expect(validate(Type.Object({ name: Type.Optional(Type.String()) }), { name: undefined }).success).toBe(true)
  })
})

describe('coercion follows Ajv\'s coerceTypes rules, from strings only', () => {
  test('converts a string that means the same thing', () => {
    const cases: Array<[TSchema, unknown, unknown]> = [
      [Type.Number(), '42', 42],
      [Type.Number(), ' 4.5 ', 4.5],
      [Type.Number(), '1e3', 1000],
      [Type.Integer(), '7', 7],
      [Type.Boolean(), 'true', true],
      [Type.Boolean(), 'false', false],
      [Type.Null(), '', null],
      [Type.Literal(42), '42', 42],
      [Type.Array(Type.Number()), '5', [5]],
    ]
    for (const [schema, input, output] of cases)
      expect([input, validate(schema, input)]).toEqual([input, { success: true, data: output }])
  })

  test('rejects strings that would lose or invent data', () => {
    const cases: Array<[TSchema, unknown]> = [
      [Type.Number(), ''],
      [Type.Number(), '   '],
      [Type.Number(), 'Infinity'],
      [Type.Integer(), '1.5'],
      [Type.Boolean(), '1'],
      [Type.Boolean(), 'yes'],
      [Type.Null(), 'null'],
    ]
    for (const [schema, input] of cases)
      expect([input, validate(schema, input).success]).toEqual([input, false])
  })

  test('never converts what is not a string', () => {
    const cases: Array<[TSchema, unknown]> = [
      [Type.String(), 123],
      [Type.String(), true],
      [Type.String(), null],
      [Type.Number(), true],
      [Type.Number(), null],
      [Type.Integer(), 1.5],
      [Type.Boolean(), 1],
      [Type.Boolean(), null],
      [Type.Null(), 0],
      [Type.Null(), false],
      [Type.Array(Type.Number()), 5],
      [Type.Enum([1, 2]), true],
    ]
    for (const [schema, input] of cases)
      expect([input, validate(schema, input).success]).toEqual([input, false])
  })

  test('an empty form field does not pass as zero, a JSON null not as anything', () => {
    const schema = Type.Object({ age: Type.Integer({ minimum: 0 }), name: Type.String() })
    const result = validate(schema, { age: '', name: null })
    expect(result.success || result.errors.map(e => e.path)).toEqual([['age'], ['name']])
  })
})

describe('schemas stay plain JSON Schema', () => {
  test('~standard is non-enumerable and never reaches the JSON output', () => {
    const schema = Type.Object({ id: Type.String() })

    expect(Object.keys(schema)).not.toContain('~standard')
    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    })
  })

  test('projections keep the same JSON purity', () => {
    const schema = Type.Object({ id: Type.Readonly(Type.String()), name: Type.String() })

    expect(JSON.parse(JSON.stringify(Type.Write(schema)))).toEqual({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    })
  })

  test('the mode tag is a symbol, so it never shows up as a key either', () => {
    const write = Type.Write(Type.Object({ id: Type.String() }))

    expect(Object.keys(write)).toEqual(['type', 'required', 'properties'])
  })
})

describe('Type.Partial', () => {
  test('accepts schema options like the built-in', () => {
    const patch = Type.Partial(Type.Object({ a: Type.String() }), { $id: '/patch' })

    expect((patch as unknown as { $id: string }).$id).toBe('/patch')
  })

  test('a property that only had a default becomes truly absent', () => {
    const patch = Type.Partial(Type.Object({ status: Type.String({ default: 'draft' }) }))

    expect(validate(patch, {})).toEqual({ success: true, data: {} })
  })

  test('keeps validating the properties that are present', () => {
    const patch = Type.Partial(Type.Object({ n: Type.Number() }))

    expect(validate(patch, { n: 1 }).success).toBe(true)
    expect(validate(patch, { n: 'no' }).success).toBe(false)
  })
})

describe('hostile and degenerate input', () => {
  test('Type.Cyclic without a root name throws instead of accepting anything', () => {
    const defs = { node: Type.Object({ password: Type.Writeonly(Type.String()) }) }
    // A JS caller can skip the second argument; the schema would be { $defs }
    // and its marks would cut nothing.
    expect(() => (Type.Cyclic as (...a: unknown[]) => unknown)(defs)).toThrow(TypeError)
    expect(() => (Type.Cyclic as (...a: unknown[]) => unknown)(defs, 'missing')).toThrow(TypeError)
    expect(Type.Cyclic(defs, 'node').$ref).toBe('node')
  })

  const schema = Type.Object({ id: Type.String() })

  test('never throws on uncloneable payloads — functions and symbols', () => {
    // Extra properties are allowed by default, so these are actually valid.
    const withFn = { id: 'x', cb: () => 1 }
    expect(validate(schema, withFn).success).toBe(true)
    expect(validate(schema, { id: 'x', s: Symbol('s') }).success).toBe(true)
    // The original is left untouched even on the manual-clone path.
    expect(typeof withFn.cb).toBe('function')
  })

  test('a cyclic payload with a function neither crashes nor hangs', () => {
    // structuredClone survives cycles; the fallback must too. The schema
    // here isn't recursive and doesn't describe `self` at all, so nothing
    // ever walks into the cycle — this succeeds rather than reporting one.
    const payload: { id: string, cb: () => number, self?: unknown } = { id: 'x', cb: () => 1 }
    payload.self = payload

    expect(validate(schema, payload).success).toBe(true)
  })

  test('the clone fallback reconstructs Dates instead of flattening them', () => {
    // A function elsewhere in the payload forces the manual clone. The Date
    // must arrive intact — Object.entries would flatten it to {} — but as a
    // fresh clone, not the same reference: sharing it by reference would let
    // Convert/Default write into a schema-described position on the
    // caller's own Date if one ever appeared there (see the class-instance
    // mutation test below, which is the same hazard for a plain instance).
    const stamp = new Date('2026-01-01')
    const anything = Type.Object({ d: Type.Any() })
    const result = validate(anything, { d: stamp, cb: () => 1 })

    expect(result.success).toBe(true)
    if (result.success) {
      const cloned = (result.data as { d: unknown }).d
      expect(cloned).toBeInstanceOf(Date)
      expect(cloned).not.toBe(stamp)
      expect((cloned as Date).getTime()).toBe(stamp.getTime())
    }
  })

  test('a function where the schema wants a string is an issue, not a crash', () => {
    const result = validate(schema, { id: () => 'nope' })

    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.errors[0]?.path).toEqual(['id'])
  })

  test('null, undefined and primitive roots against an object schema', () => {
    for (const root of [null, undefined, 42, 'str', true]) {
      const result = validate(schema, root)
      expect(result.success).toBe(false)
      if (!result.success)
        expect(result.errors[0]?.path).toEqual([])
    }
  })

  test('NaN and Infinity do not satisfy a number schema by accident', () => {
    const numeric = Type.Object({ n: Type.Number() })

    // typebox counts NaN/Infinity as numbers only per IEEE — pin the actual
    // behaviour so an engine change is caught here.
    expect(validate(numeric, { n: Number.NaN }).success).toBe(false)
    expect(validate(numeric, { n: Number.POSITIVE_INFINITY }).success).toBe(false)
  })

  test('__proto__ in the payload validates without polluting prototypes', () => {
    const result = validate(schema, JSON.parse('{"id":"x","__proto__":{"polluted":true}}'))

    expect(result.success).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test('deeply nested arrays survive the pipeline', () => {
    const deep = Type.Object({ m: Type.Array(Type.Array(Type.Array(Type.Number()))) })

    expect(validate(deep, { m: [[[1, 2]], [[3]]] }).success).toBe(true)
    const bad = validate(deep, { m: [[[1]], [['x']]] })
    expect(bad.success).toBe(false)
    if (!bad.success)
      expect(bad.errors[0]?.path).toEqual(['m', 1, 0, 0])
  })

  test('spreading a schema drops ~standard (the flipside of JSON purity)', () => {
    const spread = { ...schema }

    expect('~standard' in spread).toBe(false)
    // adopt() is the way back in.
    expect('~standard' in adopt(spread as typeof schema)).toBe(true)
  })

  test('adopt() of a frozen schema fails loudly, not silently', () => {
    const frozen = Object.freeze({ type: 'string' })

    expect(() => adopt(frozen as Parameters<typeof adopt>[0])).toThrow()
  })
})

describe('parse', () => {
  const Entity = Type.Object({
    id: Type.Readonly(Type.String()),
    title: Type.String(),
  })

  test('returns the validated data typed as the checked shape', () => {
    const data = parse(Entity, { title: 't' })

    expect(data).toEqual({ title: 't' })
    expectTypeOf(data).toEqualTypeOf<{ title: string }>()
  })

  test('coerces and defaults like validate()', () => {
    const schema = Type.Object({
      n: Type.Number(),
      page: Type.Optional(Type.Integer({ default: 1 })),
    })

    expect(parse(schema, { n: '42' })).toEqual({ n: 42, page: 1 })
  })

  test('throws a ValidationError carrying the issues', () => {
    let caught: unknown
    try {
      parse(Entity, {})
    }
    catch (error) {
      caught = error
    }

    expect(isValidationError(caught)).toBe(true)
    if (isValidationError(caught)) {
      expect(caught.name).toBe('ValidationError')
      expect(caught.message).toContain('title')
      expect(caught.issues.map(i => i.path)).toEqual([['title']])
    }
  })

  test('summarizes long issue lists instead of dumping them all', () => {
    const wide = Type.Object({
      a: Type.String(),
      b: Type.String(),
      c: Type.String(),
      d: Type.String(),
      e: Type.String(),
    })
    let caught: unknown
    try {
      parse(wide, {})
    }
    catch (error) {
      caught = error
    }

    if (isValidationError(caught)) {
      expect(caught.message).toContain('+2 more')
      expect(caught.issues).toHaveLength(5)
    }
    else {
      throw new Error('expected a ValidationError')
    }
  })

  test('parses a projection as its own shape', () => {
    const read = Type.Read(Entity)

    expect(parse(read, { id: '1', title: 't' })).toEqual({ id: '1', title: 't' })
    expect(() => parse(read, { title: 't' })).toThrow('id')
  })

  test('isValidationError rejects foreign errors', () => {
    expect(isValidationError(new Error('nope'))).toBe(false)
    expect(isValidationError(undefined)).toBe(false)
    // Duck typing (deliberate, for cross-realm errors): all three contract
    // members present → accepted; any of them missing → rejected.
    expect(isValidationError({ name: 'ValidationError', issues: [] })).toBe(false)
    expect(isValidationError({ name: 'ValidationError', message: 'm', issues: [] })).toBe(true)
  })

  test('recognizes an error thrown across a realm boundary', async () => {
    const vm = await import('node:vm')
    const foreign = vm.runInNewContext(
      `const e = new Error('x: must be string'); e.name = 'ValidationError'; e.issues = []; e`,
    )

    expect(foreign instanceof Error).toBe(false) // that's the point
    expect(isValidationError(foreign)).toBe(true)
  })
})

describe('curated re-exports', () => {
  test('Value performs ad-hoc checks against our schemas', () => {
    const schema = Type.Object({ id: Type.String() })

    expect(Value.Check(schema, { id: 'a' })).toBe(true)
    expect(Value.Check(schema, {})).toBe(false)
  })
})

// Field marks that describe a shape without enforcing it are half a
// projection: Type.Read/Type.Write already remove the excluded field from
// `properties`, but validation used to hand the raw value straight through
// as an ordinary "additional property" — a read result could still carry a
// writeOnly secret, a write result an attacker-supplied readonly id. Each
// projected node now records the keys it cut, and the pipeline deletes
// exactly those — nothing else the schema allows.
describe('projections actually remove excluded data, not just its description', () => {
  test('a read projection strips the writeOnly field from the result', () => {
    const User = Type.Object({ name: Type.String(), secret: Type.Writeonly(Type.String()) })

    expect(parse(Type.Read(User), { name: 'n', secret: 'sensitive' })).toEqual({ name: 'n' })
  })

  test('validating a full schema strips a client-supplied readonly field', () => {
    const User = Type.Object({ name: Type.String(), id: Type.Readonly(Type.String()) })

    expect(parse(User, { name: 'n', id: 'forged' })).toEqual({ name: 'n' })
  })

  test('a cut field is still judged by its own schema before it is removed', () => {
    // The data is validated the way the full schema sees it; only the
    // requiredness of a cut field is relaxed.
    const User = Type.Object({ name: Type.String(), id: Type.Readonly(Type.String()) })

    expect(validate(User, { name: 'n', id: { unvalidated: true } }).success).toBe(false)
    expect(validate(User, { name: 'n' }).success).toBe(true)
  })

  test('a key cut in one place but declared in another can\'t carry an invalid value', () => {
    const S = Type.Intersect([
      Type.Object({ b: Type.Array(Type.String()) }),
      Type.Union([
        Type.Object({ kind: Type.String(), b: Type.Writeonly(Type.String()) }, { additionalProperties: false }),
        Type.Object({ b: Type.Object({ b: Type.String() }) }),
      ]),
    ])

    expect(validate(Type.Read(S), { b: ['x'], kind: 'q' }).success).toBe(Value.Check(S, { b: ['x'], kind: 'q' }))
  })

  test('an explicitly allowed extra property survives', () => {
    const Loose = Type.Object({ name: Type.String() }, { additionalProperties: true })

    expect(parse(Loose, { name: 'n', extra: 'kept' })).toEqual({ name: 'n', extra: 'kept' } as { name: string })
  })

  test('a Record keeps its pattern-matched entries', () => {
    const Dict = Type.Record(Type.String(), Type.Number())

    expect(parse(Dict, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
  })

  // An early build leaked here: TypeBox's Clean cleans a union on a copy and returns
  // it, and the pipeline discarded the return value.
  test('a read projection of a root union strips the writeOnly field', () => {
    const Event = Type.Union([
      Type.Object({ kind: Type.Literal('login'), password: Type.Writeonly(Type.String()) }),
      Type.Object({ kind: Type.Literal('logout') }),
    ])

    expect(parse(Type.Read(Event), { kind: 'login', password: 'hunter2' })).toEqual({ kind: 'login' } as never)
  })

  test('a projection of an intersection strips on both sides', () => {
    const User = Type.Intersect([
      Type.Object({ id: Type.Readonly(Type.String()) }),
      Type.Object({ name: Type.String(), secret: Type.Writeonly(Type.String()) }),
    ])

    expect(parse(Type.Read(User), { id: '1', name: 'n', secret: 's' })).toEqual({ id: '1', name: 'n' } as never)
    expect(parse(User, { id: 'forged', name: 'n', secret: 's' })).toEqual({ name: 'n', secret: 's' } as never)
  })

  test('a projection of Type.Dependent strips inside the branch the value takes', () => {
    const S = Type.Dependent(
      Type.Object({ kind: Type.Literal('x') }),
      Type.Object({ kind: Type.Literal('x'), secret: Type.Writeonly(Type.String()) }),
      Type.Object({ name: Type.String() }),
    )

    expect(parse(Type.Read(S), { kind: 'x', secret: 's' })).toEqual({ kind: 'x' } as never)
    expect(parse(Type.Read(S), { name: 'n' })).toEqual({ name: 'n' } as never)
  })

  test('a projection of a schema with `not` still strips, and still honors the `not`', () => {
    const S = adopt<TSchema>({
      type: 'object',
      properties: { name: { type: 'string' }, secret: { type: 'string', writeOnly: true } },
      not: { required: ['forbidden'] },
    })

    expect(parse(Type.Read(S), { name: 'n', secret: 's' })).toEqual({ name: 'n' } as never)
    expect(validate(Type.Read(S), { name: 'n', forbidden: 1 }).success).toBe(false)
  })

  test('a value failing an additionalProperties schema is reported, not dropped', () => {
    const Scores = Type.Object({ name: Type.String() }, { additionalProperties: Type.Number() })

    expect(validate(Scores, { name: 'n', math: 'x' }).success).toBe(false)
    expect(parse(Scores, { name: 'n', math: '5' })).toEqual({ name: 'n', math: 5 } as never)
  })

  test('additionalProperties: false rejects an unknown key, yet takes a cut one', () => {
    const Strict = Type.Object(
      { name: Type.String(), secret: Type.Writeonly(Type.String()) },
      { additionalProperties: false },
    )

    expect(validate(Type.Read(Strict), { name: 'n', extra: 1 }).success).toBe(false)
    expect(parse(Type.Read(Strict), { name: 'n', secret: 's' })).toEqual({ name: 'n' } as never)
  })

  test('a union branch that tolerates extras does not echo another branch\'s secret', () => {
    const Loose = Type.Union([
      Type.Object({ kind: Type.String() }),
      Type.Object({ kind: Type.Literal('login'), password: Type.Writeonly(Type.String()) }),
    ])

    expect(parse(Type.Read(Loose), { kind: 'login', password: 'p' })).toEqual({ kind: 'login' } as never)
  })

  test('a default on the matching branch does not make the strip fall through', () => {
    const Account = Type.Union([
      Type.Object({ kind: Type.Literal('user'), role: Type.String({ default: 'member' }), password: Type.Writeonly(Type.String()) }),
      Type.Object({ kind: Type.Literal('bot') }),
    ])

    expect(parse(Type.Read(Account), { kind: 'user', password: 'p' })).toEqual({ kind: 'user', role: 'member' } as never)
  })

  test('a writeOnly field re-declared in a Dependent `if` is still cut', () => {
    const S = Type.Dependent(
      Type.Object({ password: Type.String() }),
      Type.Object({ email: Type.String(), password: Type.Writeonly(Type.String()) }),
      Type.Object({ email: Type.String() }),
    )

    expect(parse(Type.Read(S), { email: 'e', password: 'p' })).toEqual({ email: 'e' } as never)
  })

  test('a field marked writeOnly only inside `if` is cut from the branch taken', () => {
    const Signup = Type.Dependent(
      Type.Object({ password: Type.Writeonly(Type.String()) }),
      Type.Object({ email: Type.String(), confirm: Type.Writeonly(Type.String()) }),
      Type.Object({ email: Type.String() }),
    )

    expect(parse(Type.Read(Signup), { email: 'e', password: 'p', confirm: 'p' })).toEqual({ email: 'e' } as never)
    expect(parse(Type.Read(Type.Object({ user: Signup })), { user: { email: 'e', password: 'p' } })).toEqual({ user: { email: 'e' } } as never)
  })

  test('the `else` branch keeps every field it did not cut', () => {
    const Payment = Type.Dependent(
      Type.Object({ method: Type.Literal('card') }),
      Type.Object({ method: Type.Literal('card'), cvc: Type.Writeonly(Type.String()) }),
      Type.Object({ method: Type.Literal('sepa'), iban: Type.String() }),
    )

    expect(parse(Type.Read(Payment), { method: 'sepa', iban: 'DE00' })).toEqual({ method: 'sepa', iban: 'DE00' } as never)
    expect(parse(Type.Read(Payment), { method: 'card', cvc: '123' })).toEqual({ method: 'card' } as never)
  })

  test('overlapping union branches keep the fields of the one that matched', () => {
    const Contact = Type.Union([
      Type.Object({ email: Type.String(), secret: Type.Optional(Type.Writeonly(Type.String())) }),
      Type.Object({ email: Type.String(), fax: Type.String() }),
    ])

    expect(parse(Type.Read(Contact), { email: 'e', phone: '1' })).toEqual({ email: 'e', phone: '1' } as never)
  })

  test('oneOf and $ref pointers of adopted schemas are followed', () => {
    const secretive = { type: 'object', properties: { a: { type: 'string' }, secret: { type: 'string', writeOnly: true } } }
    const OneOf = adopt<TSchema>({ oneOf: [structuredClone(secretive), { type: 'string' }] })
    const Pointer = adopt<TSchema>({ $defs: { S: structuredClone(secretive) }, $ref: '#/$defs/S' })

    expect(parse(Type.Read(OneOf), { a: 'x', secret: 's' })).toEqual({ a: 'x' } as never)
    expect(parse(Type.Read(Pointer), { a: 'x', secret: 's' })).toEqual({ a: 'x' } as never)
  })

  test('Partial/Required/Pick/Omit of a projection stay that projection', () => {
    const User = Type.Object({
      id: Type.Readonly(Type.String()),
      name: Type.String(),
      secret: Type.Writeonly(Type.String()),
    })
    const Read = Type.Read(User)

    expect(parse(Type.Partial(Read), { id: '1', secret: 's' })).toEqual({ id: '1' } as never)
    expect(parse(Type.Required(Read), { id: '1', name: 'n', secret: 's' })).toEqual({ id: '1', name: 'n' } as never)
    expect(parse(Type.Pick(Read, ['id']), { id: '1', secret: 's' })).toEqual({ id: '1' } as never)
    expect(parse(Type.Omit(Read, ['name']), { id: '1', secret: 's' })).toEqual({ id: '1' } as never)
  })
})

describe('not/if keep their meaning around the strip', () => {
  test('a value forbidden by a sibling not is still rejected, not silently cleaned', () => {
    // A property mentioned only by `not` is undeclared, but it is not a
    // field any projection cut — it must reach Check, where the `not`
    // rejects it. (An early build's generic Clean stripped it first, so the `not`
    // trivially passed.)
    const Guarded = adopt<TSchema>({
      allOf: [
        { type: 'object', properties: { pub: { type: 'string' } } },
        {
          not: {
            type: 'object',
            required: ['secret'],
            properties: { secret: { type: 'string' } },
          },
        },
      ],
    })

    expect(validate(Guarded, { pub: 'p' }).success).toBe(true)
    expect(validate(Guarded, { pub: 'p', secret: 's' }).success).toBe(false)
  })

  test('a bare `not` sibling on an object node is honored the same way', () => {
    const Guarded = adopt<TSchema>({
      type: 'object',
      properties: { pub: { type: 'string' } },
      not: { required: ['secret'] },
    })

    expect(validate(Guarded, { pub: 'p', secret: 's' }).success).toBe(false)
  })

  test('with `not` in play, additionalProperties: false rejects an unknown key', () => {
    // The data is checked as it arrived before anything is stripped — the
    // same Check that lets the `not` see its key sees the extra one too.
    const Guarded = adopt<TSchema>({
      type: 'object',
      additionalProperties: false,
      properties: { pub: { type: 'string' } },
      not: { required: ['pub', 'other'] },
    })

    expect(validate(Guarded, { pub: 'p' }).success).toBe(true)
    expect(validate(Guarded, { pub: 'p', extra: 1 }).success).toBe(false)
  })

  test('an extra key both intersection members allow is kept', () => {
    const S = Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })])

    expect(parse(S, { a: 'x', b: '1', c: true })).toEqual({ a: 'x', b: 1, c: true } as never)
  })

  test('properties declared beside an allOf and inside it are all kept', () => {
    const S = adopt<TSchema>({ allOf: [{ type: 'object', properties: { age: { type: 'integer' } } }], properties: { name: { type: 'string' } } })

    expect(parse(S, { age: 5, name: 'n' })).toEqual({ age: 5, name: 'n' } as never)
  })
})

describe('R09 — cyclic data and hostile getters never throw', () => {
  test('a genuinely cyclic value against a recursive schema is an issue, not a crash', () => {
    const Tree = Type.Cyclic({ Node: Type.Object({ children: Type.Array(Type.Ref('Node')) }) }, 'Node')
    const value: { children: unknown[] } = { children: [] }
    value.children.push(value)

    const result = validate(Tree, value)
    expect(result.success).toBe(false)
  })

  test('a recursive schema nested anywhere is guarded, not just at the root', () => {
    const Tree = Type.Cyclic({ Node: Type.Object({ children: Type.Array(Type.Ref('Node')) }) }, 'Node')
    const value: { children: unknown[] } = { children: [] }
    value.children.push(value)

    expect(validate(Type.Object({ tree: Tree }), { tree: value }).success).toBe(false)
    expect(validate(Type.Array(Tree), [value]).success).toBe(false)
    expect(validate(Type.Union([Tree, Type.Null()]), value).success).toBe(false)
    expect(validate(Type.Partial(Type.Object({ tree: Tree })), { tree: value }).success).toBe(false)
  })

  test('cyclic data through a union never throws', () => {
    // A union's value is never copied whole to try a branch (typebox's own
    // Convert/Default do that, cycles included), so a cycle the schema
    // doesn't describe stays harmless, defaults or not.
    const payload: { kind: string, self?: unknown } = { kind: 'a' }
    payload.self = payload
    const Plain = Type.Union([Type.Object({ kind: Type.Literal('a'), secret: Type.Optional(Type.Writeonly(Type.String())) }), Type.Null()])
    const Defaulted = Type.Union([Type.Object({ kind: Type.Literal('a'), n: Type.Number({ default: 1 }) }), Type.Null()])

    expect(validate(Type.Read(Plain), payload).success).toBe(true)
    const result = validate(Defaulted, payload)
    expect(result.success && (result.data as { n: number }).n).toBe(1)
  })

  test('deep acyclic data against a recursive schema is an issue, not a crash', () => {
    const List = Type.Cyclic({ Node: Type.Object({ next: Type.Union([Type.Ref('Node'), Type.Null()]) }) }, 'Node')
    let deep: { next: unknown } = { next: null }
    for (let i = 0; i < 100_000; i++) deep = { next: deep }

    expect(() => validate(List, deep)).not.toThrow()
  })

  test('a throwing getter is reported as an issue instead of propagating', () => {
    const result = validate(Type.Object({ n: Type.Number() }), {
      get n(): number { throw new Error('getter') },
    })

    expect(result.success).toBe(false)
  })

  test('a cycle in data the schema does not even describe still validates', () => {
    // The schema isn't recursive and doesn't mention `self`, so nothing
    // walks into the cycle — this succeeds instead of reporting one.
    const payload: { id: string, self?: unknown } = { id: 'x' }
    payload.self = payload

    expect(validate(Type.Object({ id: Type.String() }), payload).success).toBe(true)
  })
})

describe('adopted schemas participate in the full pipeline (R13)', () => {
  test('a suffix renames $refs inside propertyNames too', () => {
    const schema = adopt({
      type: 'object',
      $defs: { Key: { type: 'string', minLength: 2 } },
      properties: { name: { $ref: '#/$defs/Key' } },
      propertyNames: { $ref: '#/$defs/Key' },
    } as unknown as TSchema)
    const named = Type.Read(schema, { suffix: 'Out' }) as unknown as { propertyNames: unknown }

    expect(named.propertyNames).toEqual({ $ref: '#/$defs/KeyOut' })
    expect(validate(named as unknown as TSchema, { name: 'nn' })).toEqual({ success: true, data: { name: 'nn' } })
  })

  test('pointer $refs into root $defs get defaults, coercion and real error paths', () => {
    const schema = adopt({
      type: 'object',
      $defs: {
        Item: { type: 'object', properties: { name: { type: 'string', default: 'anon' }, n: { type: 'number' } }, required: ['name'] },
        Node: { anyOf: [{ type: 'string' }, { type: 'object', properties: { next: { $ref: '#/$defs/Node' } }, required: ['next'] }] },
      },
      properties: { item: { $ref: '#/$defs/Item' }, root: { $ref: '#/$defs/Node' } },
      required: ['item'],
    } as unknown as TSchema)

    expect(validate(schema, { item: { n: '42' } })).toEqual({ success: true, data: { item: { name: 'anon', n: 42 } } })
    const bad = validate(schema, { item: {}, root: { next: { next: [] } } })
    expect(bad.success || bad.errors.map(e => [e.keyword, e.path])).toEqual([['anyOf', ['root', 'next', 'next']]])
  })

  test('Convert coerces a field on a plain adopted JSON Schema', () => {
    const S = adopt<TSchema>({ type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] })

    expect(S['~standard'].validate({ age: '42' })).toEqual({ value: { age: 42 } })
  })

  test('an adopted array/string schema also coerces', () => {
    const S = adopt<TSchema>({ type: 'array', items: { type: 'number' } })

    expect(parse(S, ['1', '2', '3'])).toEqual([1, 2, 3])
  })

  test('an object schema without `properties` still compiles', () => {
    // Stamped 'Object' with no `properties`, typebox's Compile threw outright.
    const Bare = adopt<TSchema>({ type: 'object' })
    const Dict = adopt<TSchema>({ type: 'object', additionalProperties: { type: 'number' } })

    expect(validate(Bare, { a: 1 }).success).toBe(true)
    expect(parse(Dict, { a: 1 })).toEqual({ a: 1 })
    expect(validate(Dict, { a: 'x' }).success).toBe(false)
    expect(JSON.stringify(Dict)).toBe('{"type":"object","additionalProperties":{"type":"number"}}')
  })

  test('declared properties beside anyOf are still coerced and cut', () => {
    const S = adopt<TSchema>({
      type: 'object',
      properties: { n: { type: 'number' }, secret: { type: 'string', writeOnly: true } },
      anyOf: [{ required: ['n'] }],
    })

    expect(parse(Type.Read(S), { n: '1', secret: 's' })).toEqual({ n: 1 } as never)
  })

  test('a plain JSON Schema nested in a Type.Object is adopted along with it', () => {
    const S = adopt(Type.Object({ inner: { type: 'object', properties: { n: { type: 'number' } } } as unknown as TSchema }))

    expect(parse(S, { inner: { n: '1' } })).toEqual({ inner: { n: 1 } } as never)
  })

  test('projections of adopted schemas strip wherever the fields sit', () => {
    const secretive = { type: 'object', properties: { a: { type: 'string' }, secret: { type: 'string', writeOnly: true } } }
    const Untyped = adopt<TSchema>({ properties: secretive.properties })
    const Dict = adopt<TSchema>({ type: 'object', additionalProperties: structuredClone(secretive) })

    expect(parse(Type.Read(Untyped), { a: 'x', secret: 's' })).toEqual({ a: 'x' })
    expect(parse(Type.Read(Dict), { k: { a: 'x', secret: 's' } })).toEqual({ k: { a: 'x' } })
  })
})

// Validation judges the data as it arrived (the lenient twin), and only then
// are the cut fields removed — strip() must never disagree with the Check
// about which branch a value took.
describe('the strip agrees with the Check on every branch', () => {
  test('a forged key that flips a Dependent branch smuggles nothing through', () => {
    const Account = Type.Dependent(
      Type.Object({ id: Type.Readonly(Type.String()) }),
      Type.Object({ name: Type.String() }),
      Type.Object({ name: Type.String(), role: Type.Optional(Type.Readonly(Type.String())) }),
    )

    expect(parse(Account, { name: 'n', role: 'admin' })).toEqual({ name: 'n' } as never)
    expect(parse(Account, { id: 'forged', name: 'n', role: 'admin' })).toEqual({ name: 'n' } as never)
  })

  test('a Dependent read projection cuts the other branch\'s fields and keeps its constraints', () => {
    const Login = Type.Dependent(
      Type.Object({ password: Type.Writeonly(Type.String()) }),
      Type.Object({ email: Type.String({ format: 'email' }) }),
      Type.Object({ email: Type.String(), apiKey: Type.Writeonly(Type.String()) }),
    )

    expect(parse(Type.Read(Login), { password: 'p', email: 'a@b.c', apiKey: 'k' })).toEqual({ email: 'a@b.c' } as never)
    expect(validate(Type.Read(Login), { password: 'p', email: 'not-an-email' }).success).toBe(false)
    expect(parse(Type.Read(Type.Union([Login, Type.Null()])), { password: 'p', email: 'a@b.c' })).toEqual({ email: 'a@b.c' } as never)
  })

  test('a key readOnly in one union variant and writable in another follows the variant', () => {
    const Item = Type.Union([
      Type.Object({ id: Type.Readonly(Type.String()), name: Type.String() }),
      Type.Object({ id: Type.String(), name: Type.String(), extra: Type.Number() }),
    ])

    expect(parse(Item, { id: 'forged', name: 'n' })).toEqual({ name: 'n' } as never)
    expect(parse(Item, { id: 'mine', name: 'n', extra: 1 })).toEqual({ id: 'mine', name: 'n', extra: 1 } as never)
  })

  test('a branch cut is honored through refs, intersections and nested unions', () => {
    const A = Type.Object({ kind: Type.Literal('a'), secret: Type.Writeonly(Type.String()) })
    const Loose = Type.Object({ kind: Type.String() })
    const Tree = Type.Cyclic({ A, L: Loose, N: Type.Union([Type.Ref('A'), Type.Ref('L')]) }, 'N')

    expect(parse(Type.Read(Tree), { kind: 'b', secret: 's' })).toEqual({ kind: 'b' } as never)
    expect(parse(Type.Read(Type.Union([Type.Intersect([Loose, A]), Loose])), { kind: 'b', secret: 's' })).toEqual({ kind: 'b' } as never)
    expect(parse(Type.Read(Type.Union([Type.Union([A, Type.Null()]), Loose])), { kind: 'b', secret: 's' })).toEqual({ kind: 'b' } as never)
  })

  test('a key the matching variant declares — directly, via allOf, or as a record entry — stays', () => {
    const A = Type.Object({ kind: Type.Literal('a'), token: Type.Writeonly(Type.String()) })
    const ViaAllOf = Type.Union([A, Type.Intersect([Type.Object({ kind: Type.Literal('b') }), Type.Object({ token: Type.String() })])])
    const Record = Type.Union([A, Type.Record(Type.String(), Type.String())])

    expect(parse(Type.Read(ViaAllOf), { kind: 'b', token: 't' })).toEqual({ kind: 'b', token: 't' } as never)
    expect(parse(Type.Read(Record), { kind: 'b', token: 't' })).toEqual({ kind: 'b', token: 't' } as never)
  })

  test('oneOf branches that overlap once cut still accept the value', () => {
    const S = adopt<TSchema>({
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' }, secret: { type: 'string', writeOnly: true } }, required: ['a', 'secret'] },
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      ],
    })

    expect(parse(Type.Read(S), { a: 'x', secret: 's' })).toEqual({ a: 'x' } as never)
  })

  test('recursive unions cost linear time, not exponential', () => {
    const Node = Type.Cyclic({
      Node: Type.Union([
        Type.Object({ kind: Type.Literal('a'), child: Type.Union([Type.Ref('Node'), Type.Null()]), secret: Type.Optional(Type.Writeonly(Type.String())) }),
        Type.Object({ kind: Type.Literal('b'), child: Type.Union([Type.Ref('Node'), Type.Null()]) }),
        Type.Object({ kind: Type.Literal('c'), child: Type.Union([Type.Ref('Node'), Type.Null()]) }),
      ]),
    }, 'Node')
    let value: unknown = null
    for (let i = 0; i < 16; i++) value = { kind: 'c', child: value }

    const started = performance.now()
    expect(validate(Type.Read(Node), value).success).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('cuts survive whatever a projection is built into', () => {
  const User = Type.Object({ id: Type.Readonly(Type.String()), email: Type.String(), password: Type.Writeonly(Type.String()) })
  const row = { id: 'i', email: 'e', password: 'p' }

  test('reshaping a projected union, intersection or Cyclic stays projected all the way down', () => {
    const Union = Type.Read(Type.Union([User, Type.Null()]))
    const Intersect = Type.Read(Type.Intersect([User, Type.Object({ x: Type.Optional(Type.Number()) })]))
    const Cyclic = Type.Read(Type.Cyclic({ U: User }, 'U'))

    for (const shaped of [Type.Partial(Union), Type.Pick(Intersect, ['id', 'email']), Type.Omit(Cyclic, ['email']), Type.Pick(Cyclic, ['email'])])
      expect(Object.keys(parse(shaped, row) as object)).not.toContain('password')
  })

  test('a projection rebuilt by Interface, Extends, Evaluate or a reshaped intersection keeps its cuts', () => {
    const Read = Type.Read(User)
    const built = [
      Type.Interface([Read], {}),
      Type.Evaluate(Type.Intersect([Read, Type.Object({ x: Type.Optional(Type.Number()) })])),
      Type.Partial(Type.Intersect([Read])),
      Type.Partial(Type.Union([Read, Type.Null()])),
    ]

    for (const schema of built)
      expect(Object.keys(parse(schema, row) as object)).not.toContain('password')
  })
})

describe('hand-written JSON Schema shapes are projected too', () => {
  const secretive = { type: 'object', properties: { a: { type: 'string' }, secret: { type: 'string', writeOnly: true } } }

  test('$ref to the root, to an $id, and into definitions', () => {
    const Root = adopt<TSchema>({ type: 'object', properties: { secret: { type: 'string', writeOnly: true }, child: { $ref: '#' } } })
    const ById = adopt<TSchema>({ type: 'object', properties: { a: { $id: 'S', ...structuredClone(secretive) }, b: { $ref: 'S' } } })
    const Definitions = adopt<TSchema>({ definitions: { S: structuredClone(secretive) }, type: 'object', properties: { s: { $ref: '#/definitions/S' } } })

    expect(parse(Type.Read(Root), { secret: 's', child: { secret: 's' } })).toEqual({ child: {} } as never)
    expect(parse(Type.Read(ById), { a: { secret: 's' }, b: { secret: 's' } })).toEqual({ a: {}, b: {} } as never)
    expect(parse(Type.Read(Definitions), { s: { secret: 's' } })).toEqual({ s: {} } as never)
  })

  test('draft-07 tuples with additionalItems', () => {
    const Tuple = adopt<TSchema>({ type: 'array', items: [{ type: 'string' }], additionalItems: structuredClone(secretive) })

    expect(parse(Type.Read(Tuple), ['x', { a: 'y', secret: 's' }])).toEqual(['x', { a: 'y' }] as never)
  })

  test('a mark nested inside a Dependent `if` is cut from the data', () => {
    const S = adopt<TSchema>({
      if: { type: 'object', properties: { auth: { type: 'object', properties: { password: { type: 'string', writeOnly: true } }, required: ['password'] } }, required: ['auth'] },
      then: { type: 'object', properties: { auth: { type: 'object', properties: { method: { type: 'string' } } } } },
    })

    expect(parse(Type.Read(S), { auth: { method: 'pw', password: 'p' } })).toEqual({ auth: { method: 'pw' } } as never)
  })

  test('boolean subschemas neither throw nor block a projection', () => {
    const S = adopt<TSchema>({ type: 'object', properties: { meta: true, secret: { type: 'string', writeOnly: true } } })

    expect(parse(S, { meta: 1 })).toEqual({ meta: 1 } as never)
    expect(parse(Type.Read(S), { meta: 1, secret: 's' })).toEqual({ meta: 1 } as never)
  })

  test('suffix renames JSON-pointer refs along with their definitions', () => {
    const S = adopt<TSchema>({ $defs: { S: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }, type: 'object', properties: { s: { $ref: '#/$defs/S' } }, required: ['s'] })

    expect(parse(Type.Read(S, { suffix: 'Out' }), { s: { name: 'n' } })).toEqual({ s: { name: 'n' } } as never)
  })
})

describe('cuts that must hold wherever the data sits', () => {
  const Profile = Type.Object({ bio: Type.String(), secret: Type.Optional(Type.Writeonly(Type.String())), verified: Type.Optional(Type.Readonly(Type.Boolean())) })
  const A = Type.Object({ id: Type.Readonly(Type.String()), profile: Profile })
  const B = Type.Object({ profile: Type.Object({ avatar: Type.String() }) })
  const input = { id: '1', profile: { bio: 'b', avatar: 'a', secret: 's', verified: true } }

  test('merging projections keeps the cuts made deep inside them', () => {
    const merged = [
      Type.Evaluate(Type.Read(Type.Intersect([A, B]))),
      Type.Evaluate(Type.Intersect([Type.Read(A), Type.Read(B)])),
      Type.Interface([Type.Read(A), Type.Read(B)], {}),
      Type.Partial(Type.Intersect([Type.Read(A), Type.Read(B)])),
    ]

    for (const schema of merged)
      expect((parse(schema, input) as { profile: object }).profile).not.toHaveProperty('secret')
    expect(parse(Type.Index(Type.Read(Type.Intersect([A, B])), ['profile']), input.profile)).not.toHaveProperty('secret')
    expect((parse(Type.Evaluate(Type.Write(Type.Intersect([A, B]))), input) as { profile: object }).profile).not.toHaveProperty('verified')
  })

  test('an intersection member that tolerates any key does not rescue a cut one', () => {
    const Loose = Type.Record(Type.String(), Type.Unknown())

    expect(parse(Type.Intersect([Type.Object({ id: Type.Readonly(Type.String()), name: Type.String() }), Loose]), { id: 'forged', name: 'n' })).toEqual({ name: 'n' } as never)
    expect(parse(Type.Read(Type.Intersect([Type.Object({ name: Type.String(), password: Type.Writeonly(Type.String()) }), Loose])), { name: 'n', password: 'p' })).toEqual({ name: 'n' } as never)
  })

  test('a field marked in `if` is cut even when `then` declares it', () => {
    const S = Type.Dependent(
      Type.Object({ password: Type.Writeonly(Type.String()) }),
      Type.Object({ email: Type.String(), password: Type.String() }),
      Type.Object({ email: Type.String() }),
    )

    expect(parse(Type.Read(S), { email: 'e', password: 'p' })).toEqual({ email: 'e' } as never)
  })

  test('a mark reached through a $ref in `if` counts too', () => {
    const S = Type.Cyclic({
      Cond: Type.Object({ kind: Type.Literal('x'), role: Type.Readonly(Type.String()) }),
      Root: Type.Dependent(Type.Ref('Cond'), Type.Object({ kind: Type.Literal('x') }), Type.Object({ kind: Type.String() })),
    }, 'Root')

    expect(parse(S, { kind: 'x', role: 'admin' })).toEqual({ kind: 'x' } as never)
  })

  test('KeyOf and Conditional of a projection see the projection, not its source', () => {
    const User = Type.Object({ id: Type.Readonly(Type.String()), name: Type.String(), password: Type.Writeonly(Type.String()) })
    const Read = Type.Read(User)

    expect(validate(Type.KeyOf(Read), 'password').success).toBe(false)
    expect(parse(Type.Conditional(Read, Type.Object({}), Read, Type.Null()), { id: 'i', name: 'n', password: 'p' })).toEqual({ id: 'i', name: 'n' } as never)
  })

  test('long recursive lists validate in linear time', () => {
    const Comment = Type.Cyclic({ C: Type.Object({ id: Type.Readonly(Type.String()), text: Type.String(), reply: Type.Union([Type.Ref('C'), Type.Null()]) }) }, 'C')
    let chain: unknown = null
    for (let i = 0; i < 1500; i++) chain = { id: String(i), text: 't', reply: chain }

    const started = performance.now()
    expect(validate(Comment, chain).success).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('a subschema shared by several parents stays shared in a projection', () => {
    const Shared = Type.Object({ v: Type.String(), secret: Type.Writeonly(Type.String()) })
    const Read = Type.Read(Type.Object({ a: Shared, b: Shared })) as unknown as { properties: { a: unknown, b: unknown } }

    expect(Read.properties.a).toBe(Read.properties.b)
  })
})

describe('JSON Schema $ref forms are followed like JSON Schema resolves them', () => {
  const secretive = () => ({ type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', readOnly: true } }, required: ['name'] })
  const forged = { name: 'y', role: 'admin' }

  test.each([
    ['a pointer into properties', { type: 'object', properties: { a: secretive(), b: { $ref: '#/properties/a' } } }],
    ['an $anchor', { type: 'object', $defs: { X: { $anchor: 'thing', ...secretive() } }, properties: { b: { $ref: '#thing' } } }],
    ['an absolute URI to a relative $id', { $id: 'http://ex.com/root.json', type: 'object', $defs: { X: { $id: 'item.json', ...secretive() } }, properties: { b: { $ref: 'http://ex.com/item.json' } } }],
    ['a relative ref against a nested base', { $id: 'http://ex.com/a/root.json', type: 'object', properties: { b: { $ref: 'item.json' }, c: { $id: 'http://ex.com/a/item.json', ...secretive() } } }],
    ['a ~1-escaped pointer', { type: 'object', $defs: { 'a/b': secretive() }, properties: { b: { $ref: '#/$defs/a~1b' } } }],
  ])('%s', (_, schema) => {
    expect(parse(adopt(schema as TSchema), { b: forged })).toEqual({ b: { name: 'y' } } as never)
  })

  test('a pointer resolves from the resource root, not the nearest $defs', () => {
    const S = adopt<TSchema>({
      type: 'object',
      $defs: { A: secretive() },
      properties: { inner: { type: 'object', $defs: { A: { type: 'object' } }, properties: { v: { $ref: '#/$defs/A' } } } },
    })

    expect(parse(S, { inner: { v: forged } })).toEqual({ inner: { v: { name: 'y' } } } as never)
  })

  test('a $ref that leads nowhere fails instead of guessing what to cut', () => {
    const S = adopt<TSchema>({ type: 'object', properties: { id: { type: 'string', readOnly: true }, b: { anyOf: [{ $ref: '#/nowhere' }, { type: 'object' }] } } })

    const result = validate(S, { b: {} })
    expect(!result.success && result.errors[0]?.keyword).toBe('$ref')
  })

  test('dependentSchemas, dependencies and unevaluatedProperties are projected', () => {
    const readOnlyId = { type: 'object', properties: { id: { type: 'string', readOnly: true } } }

    expect(parse(adopt<TSchema>({ type: 'object', properties: { a: { type: 'string' } }, dependentSchemas: { a: structuredClone(readOnlyId) } }), { a: 'x', id: 'forged' })).toEqual({ a: 'x' } as never)
    expect(parse(adopt<TSchema>({ type: 'object', properties: { a: { type: 'string' } }, dependencies: { a: structuredClone(readOnlyId) } }), { a: 'x', id: 'forged' })).toEqual({ a: 'x' } as never)
    expect(parse(adopt<TSchema>({ type: 'object', properties: { a: { type: 'number' } }, unevaluatedProperties: structuredClone(readOnlyId) }), { a: 1, z: { id: 'forged' } })).toEqual({ a: 1, z: {} } as never)
  })

  test('a self-referencing schema under anyOf validates instead of overflowing', () => {
    const S = adopt<TSchema>({ type: 'object', properties: { id: { type: 'string', readOnly: true }, child: { anyOf: [{ $ref: '#' }, { type: 'null' }] } } })

    expect(parse(S, { id: 'x', child: { id: 'y', child: null } })).toEqual({ child: { child: null } } as never)
  })
})

describe('a projection stays a schema its own results satisfy', () => {
  test('a key one allOf member cuts is no longer required by another', () => {
    const Note = Type.Intersect([
      Type.Object({ a: Type.String(), note: Type.Writeonly(Type.String()) }),
      Type.Object({ note: Type.String() }),
    ])
    const Read = Type.Read(Note)
    const result = parse(Read, { a: 'x', note: 'n' })

    expect(result).toEqual({ a: 'x' } as never)
    expect(Value.Check(Read, result)).toBe(true)
    expect(Value.Check(Note, { a: 'x' })).toBe(false)
  })

  test('below oneOf, a cut key is held to its own schema while matching branches', () => {
    const S = adopt<TSchema>({
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' }, pw: { type: 'string', writeOnly: true } }, required: ['a'] },
        { type: 'object', properties: { a: { type: 'string' }, pw: { type: 'number' } }, required: ['a', 'pw'] },
      ],
    })

    expect(validate(S, { a: 'x', pw: 5 }).success).toBe(true)
    expect(parse(Type.Read(S), { a: 'x', pw: 5 })).toEqual({ a: 'x', pw: 5 } as never)
    expect(parse(Type.Read(S), { a: 'x', pw: 's' })).toEqual({ a: 'x' } as never)
  })
})

describe('fourth review: deferred branch checks and mixed rebuilds', () => {
  test('a recursive union with no discriminator stays linear', () => {
    const Node = Type.Cyclic({
      N: Type.Union([
        Type.Object({ id: Type.Readonly(Type.String()), next: Type.Union([Type.Ref('N'), Type.Null()]) }),
        Type.Object({ name: Type.String(), next: Type.Union([Type.Ref('N'), Type.Null()]) }),
      ]),
    }, 'N')
    let chain: unknown = null
    for (let i = 0; i < 2000; i++) chain = { id: String(i), next: chain }

    const started = performance.now()
    expect(validate(Node, chain).success).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('unevaluatedProperties declares nothing a sibling already evaluated', () => {
    const P = Type.Union([Type.Object({ k: Type.Literal('a'), secret: Type.Writeonly(Type.String()) }), Type.Object({ k: Type.Literal('b') })])
    const S = Type.Intersect([Type.Object({ p: P })], { unevaluatedProperties: Type.Object({ secret: Type.String() }) })

    expect(parse(Type.Read(S), { p: { k: 'a', secret: 's' } })).toEqual({ p: { k: 'a' } } as never)
  })

  test('a plain member keeps its own marks when rebuilt next to a projection', () => {
    const User = Type.Object({ name: Type.String(), password: Type.Writeonly(Type.String()) })
    const Extra = Type.Object({ pin: Type.Writeonly(Type.String()), note: Type.String() })
    const data = { name: 'n', password: 'p', pin: '1', note: 'x' }
    const control = parse(Type.Intersect([Type.Read(User), Extra]), data)

    expect(control).toEqual({ name: 'n', pin: '1', note: 'x' } as never)
    expect(parse(Type.Evaluate(Type.Intersect([Type.Read(User), Extra])), data)).toEqual(control)
    expect(parse(Type.Interface([Type.Read(User)], { pin: Type.Writeonly(Type.String()), note: Type.String() }), data)).toEqual(control)
  })

  test('Partial of a union mixing modes keeps each member\'s cuts', () => {
    const A = Type.Object({ k: Type.Literal('a'), password: Type.Writeonly(Type.String()) })
    const B = Type.Object({ k: Type.Literal('b'), created: Type.Readonly(Type.String()) })
    const S = Type.Partial(Type.Union([Type.Read(A), Type.Write(B)]))

    expect(parse(S, { k: 'a', password: 'p' })).toEqual({ k: 'a' } as never)
    expect(parse(S, { k: 'b', created: 'c' })).toEqual({ k: 'b' } as never)
  })

  test('Index of a key the projection cut is not the source\'s field', () => {
    const User = Type.Object({ name: Type.String(), password: Type.Writeonly(Type.String()) })

    expect(validate(Type.Index(Type.Read(User), ['password']), 'secret').success).toBe(false)
  })

  test('a plain schema picked by Conditional stays plain, even if it looks like a projection', () => {
    const User = Type.Object({ id: Type.Readonly(Type.String()), password: Type.Writeonly(Type.String()) })
    const Read = Type.Read(User)
    const Plain = Type.Object({ id: Type.Readonly(Type.String()) })

    expect(parse(Type.Conditional(Read, Type.String(), Type.Never(), Plain), { id: 'forged' })).toEqual({} as never)
  })

  test('below oneOf a cut key keeps its requiredness, through $ref too', () => {
    const S = adopt<TSchema>({
      $defs: {
        A: { type: 'object', properties: { kind: { type: 'string' }, pw: { type: 'string', writeOnly: true } }, required: ['kind', 'pw'] },
        B: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], additionalProperties: false },
      },
      oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }],
    })

    expect(validate(Type.Read(S), { kind: 'k', pw: 5 }).success).toBe(Value.Check(S, { kind: 'k', pw: 5 }))
    expect(parse(Type.Read(S), { kind: 'k' })).toEqual({ kind: 'k' } as never)
  })

  test('a nested intersection that cuts a key stops requiring it at every level', () => {
    const Read = Type.Read(Type.Intersect([
      Type.Intersect([Type.Object({ note: Type.Writeonly(Type.String()) }), Type.Object({ a: Type.String() })]),
      Type.Object({ note: Type.String() }),
    ]))
    const result = parse(Read, { a: 'a', note: 'n' })

    expect(result).toEqual({ a: 'a' } as never)
    expect(Value.Check(Read, result)).toBe(true)
  })
})

describe('fifth review: fuzz-found shapes', () => {
  const Signup = Type.Dependent(
    Type.Object({ password: Type.Writeonly(Type.String()) }),
    Type.Object({ email: Type.String(), confirm: Type.Writeonly(Type.String()) }),
    Type.Object({ email: Type.String() }),
  )
  const data = { email: 'e', password: 'p', confirm: 'p' }

  test('a field marked only in `if` stays cut when the read projection is nested', () => {
    expect(parse(Type.Object({ user: Type.Read(Signup) }), { user: data })).toEqual({ user: { email: 'e' } } as never)
    expect(parse(Type.Array(Type.Read(Signup)), [data])).toEqual([{ email: 'e' }] as never)
    const Audit = Type.Dependent(Type.Object({ stamp: Type.Readonly(Type.String()) }), Type.Object({ note: Type.String() }), Type.Object({ note: Type.String() }))
    expect(parse(Type.Read(Type.Write(Audit)), { note: 'n', stamp: 's' })).toEqual({ note: 'n' } as never)
  })

  test('a key marked in an `if` that did not match is kept where `else` declares it', () => {
    const Payment = Type.Dependent(
      Type.Object({ method: Type.Literal('card'), token: Type.Writeonly(Type.String()) }),
      Type.Object({ method: Type.Literal('card'), last4: Type.String() }),
      Type.Object({ method: Type.String(), token: Type.String() }),
    )
    const Read = Type.Read(Payment)
    const result = parse(Read, { method: 'sepa', token: 'pub' })

    expect(result).toEqual({ method: 'sepa', token: 'pub' } as never)
    expect(Value.Check(Read, result)).toBe(true)
  })

  test('Evaluate keeps a mark on a property two intersection members both declare', () => {
    const User = Type.Object({ name: Type.String(), credentials: Type.Writeonly(Type.Object({ password: Type.String() })) })
    const WithOtp = Type.Intersect([User, Type.Object({ credentials: Type.Object({ password: Type.String(), otp: Type.Optional(Type.String()) }) })])
    const row = { name: 'n', credentials: { password: 'p', otp: '1' } }

    expect(parse(Type.Evaluate(Type.Read(WithOtp)), row)).toEqual({ name: 'n' } as never)
    expect((Type.Evaluate(WithOtp) as unknown as { properties: { credentials: { writeOnly?: boolean } } }).properties.credentials.writeOnly).toBe(true)
    const Doc = Type.Intersect([
      Type.Object({ meta: Type.Readonly(Type.Object({ by: Type.String() })) }),
      Type.Object({ meta: Type.Object({ by: Type.String() }), title: Type.String() }),
    ])
    expect(parse(Type.Evaluate(Doc), { meta: { by: 'forged' }, title: 't' })).toEqual({ title: 't' } as never)
  })

  test('Evaluate of a projected intersection is still that projection', () => {
    const A = Type.Object({ id: Type.Readonly(Type.String()), name: Type.String() })
    const B = Type.Object({ pw: Type.Writeonly(Type.String()) })

    expect(parse(Type.Evaluate(Type.Read(Type.Intersect([A, B]))), { id: '1', name: 'n', pw: 'p' })).toEqual({ id: '1', name: 'n' } as never)
  })

  test('a key one member cuts is unrequired in a member reached through a Cyclic', () => {
    const Tree = Type.Cyclic({ Node: Type.Object({ id: Type.String(), children: Type.Array(Type.Ref('Node')) }) }, 'Node')
    const S = Type.Intersect([Type.Object({ id: Type.Readonly(Type.String()) }), Tree])
    const result = parse(S, { children: [] })

    expect(result).toEqual({ children: [] } as never)
    expect(Value.Check(Type.Write(S), result)).toBe(true)
  })

  test('a cut field\'s Cyclic, kept aside for validation, stays out of the projection itself', () => {
    // Two Type.Cyclic with the same definition name collide in typebox's own
    // resolution — the full schema rejects this data, and validation, which
    // judges like the full schema, agrees. The projection's schema, though,
    // no longer holds the cut field, and must not trip over it.
    const S = Type.Object({
      password: Type.Optional(Type.Writeonly(Type.Cyclic({ Node: Type.String() }, 'Node'))),
      tree: Type.Cyclic({ Node: Type.Object({ kids: Type.Optional(Type.Array(Type.Ref('Node'))) }) }, 'Node'),
    })
    const data = { tree: { kids: [{}] } }

    expect(Value.Check(Type.Read(S), data)).toBe(true)
    expect(validate(Type.Read(S), data).success).toBe(Value.Check(S, data))
  })

  test('a branch holding its own Cyclic is matched in its own scope', () => {
    const S = Type.Union([
      Type.Union([
        Type.Object({ b: Type.Cyclic({ A: Type.String() }, 'A'), pw: Type.Cyclic({ A: Type.String() }, 'A') }),
        Type.Object({ c: Type.Tuple([Type.String()]) }),
      ]),
      Type.Object({ c: Type.Writeonly(Type.String()), pw: Type.String() }),
    ])

    expect(parse(Type.Read(S), { c: ['x'] })).toEqual({ c: ['x'] } as never)
  })

  test('a cut field relying on a default is defaulted before it is judged', () => {
    const U = Type.Union([Type.Object({ kind: Type.Literal('a') }), Type.Object({ kind: Type.Literal('b'), k2: Type.String({ default: 'd' }) })])
    const S = Type.Object({ k4: Type.Writeonly(U), k6: Type.String() })

    expect(parse(Type.Read(S), { k4: { kind: 'b' }, k6: 's' })).toEqual({ k6: 's' } as never)
  })
})

describe('the cut field kept aside for validation is the field as it was', () => {
  test('it follows a suffix rename of the definitions it names', () => {
    const Node = Type.Cyclic({
      A: Type.Union([
        Type.Object({ n: Type.Array(Type.String()) }),
        Type.Object({ n: Type.Writeonly(Type.Object({ child: Type.Ref('A') })) }),
      ]),
    }, 'A')

    expect(parse(Type.Read(Node, { suffix: 'Out' }), { n: { child: { n: [] } } })).toEqual({} as never)
  })

  test('it goes back to its own position, so same-named Cyclic names resolve as on the full schema', () => {
    const S = Type.Object({
      pw: Type.Optional(Type.Object({ b: Type.Cyclic({ A: Type.String() }, 'A') })),
      c: Type.Writeonly(Type.Cyclic({ A: Type.Object({ child: Type.Optional(Type.Ref('A')) }), B: Type.String() }, 'A')),
    })

    expect(validate(Type.Read(S), { c: {} }).success).toBe(Value.Check(S, { c: {} }))
  })

  test('defaults are part of the value branches are matched against', () => {
    // Once defaulted, { a: { id: 3 } } is the first variant too — where `a`
    // is an ordinary field. The data as the full schema sees it decides.
    const S = Type.Object({
      b: Type.Union([
        Type.Object({ a: Type.Object({ id: Type.Number() }) }),
        Type.Object({ a: Type.Writeonly(Type.Object({ id: Type.Optional(Type.Integer({ default: 3 })) })) }),
      ]),
    })

    expect(parse(Type.Read(S), { b: { a: {} } })).toEqual({ b: { a: { id: 3 } } } as never)
  })

  test('a union branch does not default its way into the result', () => {
    const S = Type.Union([Type.Object({ c: Type.Boolean({ default: false }) }), Type.Object({ c: Type.Readonly(Type.Number()) })])

    expect(parse(S, { c: -3 })).toEqual({} as never)
  })

  test('a key one intersection member cuts is not defaulted back by another', () => {
    const S = Type.Object({ c: Type.Intersect([Type.Object({ b: Type.Readonly(Type.Integer()) }), Type.Object({ b: Type.Integer({ default: 3 }) })]) })

    expect(parse(S, { c: { b: -2 } })).toEqual({ c: {} } as never)
    expect(parse(S, { c: {} })).toEqual({ c: {} } as never)
  })

  test('a node that cuts a key vouches for nothing beneath it', () => {
    const S = Type.Union([
      Type.Object({ kind: Type.Readonly(Type.Object({ n: Type.Literal(1) })) }),
      Type.Object({ kind: Type.Union([Type.Object({ n: Type.Readonly(Type.String()) }), Type.Object({ b: Type.Readonly(Type.String()) })]) }),
    ])

    expect(parse(S, { kind: { n: 1 } })).toEqual({ kind: {} } as never)
  })
})

// typebox's own Convert, Default and error collection try every union branch
// on the whole subtree, recursively: on a recursive union a few hundred bytes
// took seconds — valid data with defaults included.
describe('recursive unions cost linear time in every stage', () => {
  const Node = Type.Cyclic({
    A: Type.Union([
      Type.Object({ kind: Type.Literal('p'), n: Type.Number({ default: 1 }), x: Type.Union([Type.Ref('A'), Type.Null()]) }),
      Type.Object({ kind: Type.Literal('q'), x: Type.Union([Type.Ref('A'), Type.Null()]) }),
      Type.Object({ kind: Type.Literal('r'), x: Type.Union([Type.Ref('A'), Type.Null()]) }),
    ]),
  }, 'A')
  const chain = (depth: number, kind: string, leaf: unknown): unknown => {
    let value = leaf
    for (let i = 0; i < depth; i++) value = { kind, x: value }
    return value
  }
  const timed = (run: () => unknown): number => {
    const started = performance.now()
    run()
    return performance.now() - started
  }

  test('valid data whose branch comes last', () => {
    expect(timed(() => expect(validate(Node, chain(200, 'r', null)).success).toBe(true))).toBeLessThan(1000)
  })

  test('invalid data at the bottom, with a precise issue', () => {
    let result: ReturnType<typeof validate> | undefined
    expect(timed(() => (result = validate(Node, chain(200, 'p', { kind: 'zzz', x: null }))))).toBeLessThan(1000)
    expect(result?.success).toBe(false)
    expect(!result?.success && result?.errors.length).toBeGreaterThan(0)
  })

  test('an array branch, which coercion may wrap any value into, stays linear too', () => {
    const Nested = Type.Cyclic({
      A: Type.Union([
        Type.Array(Type.Ref('A')),
        Type.Object({ kind: Type.Literal('p'), x: Type.Union([Type.Ref('A'), Type.Null()]) }),
        Type.Object({ kind: Type.Literal('q'), x: Type.Union([Type.Ref('A'), Type.Null()]) }),
      ]),
    }, 'A')

    expect(timed(() => validate(Nested, chain(100, 'p', { kind: 'zzz', x: null })))).toBeLessThan(1000)
  })

  test('a tagged union reports the branch the value meant', () => {
    const result = validate(Node, { kind: 'q', x: { kind: 'p', n: 'nope', x: null } })

    expect(!result.success && result.errors.map(issue => [issue.path.join('.'), issue.keyword])).toEqual([['x.n', 'type']])
  })

  test('conversion and defaults still reach every level', () => {
    expect(parse(Node, { kind: 'p', n: 2, x: { kind: 'p', n: '5', x: null } })).toEqual({ kind: 'p', n: 2, x: { kind: 'p', n: 5, x: null } } as never)
    expect(parse(Node, { kind: 'q', x: { kind: 'q', x: { kind: 'p', x: null } } })).toEqual({ kind: 'q', x: { kind: 'q', x: { kind: 'p', n: 1, x: null } } } as never)
  })
})
