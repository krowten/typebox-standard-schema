import type { TSchema } from './index'
import type { JsonSchemaTarget } from './json-schema'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, test } from 'bun:test'
import { adopt, Type, validate } from './index'

// Standard JSON Schema (`~standard.jsonSchema.input()/output()`). The matrix
// at the top runs every schema through every target and io against the
// official meta-schemas (Ajv) and against validate() on sample data; the
// sections below pin the design decisions one by one.

type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0'
type Io = 'input' | 'output'
// Generated schemas are inspected structurally, by key.
type Out = Record<string, any>

const targets: Target[] = ['draft-2020-12', 'draft-07', 'openapi-3.0']
const ios: Io[] = ['input', 'output']

function gen(schema: TSchema, io: Io, target: JsonSchemaTarget, libraryOptions?: Record<string, unknown>): Out {
  return (schema as any)['~standard'].jsonSchema[io]({ target, libraryOptions })
}

// ─── Ajv helpers ─────────────────────────────────────────────────────────────

const ajv07 = () => addFormats(new Ajv({ strict: false, allErrors: true }))
const ajv2020 = () => addFormats(new Ajv2020({ strict: false, allErrors: true }))

// OpenAPI 3.0 -> draft-07, only so Ajv can run the meta-schema and behavioural
// samples against an OpenAPI output (boolean exclusive bounds and `nullable`
// are the differences that matter for what we emit).
function oasToDraft07(node: unknown): unknown {
  if (Array.isArray(node))
    return node.map(oasToDraft07)
  if (!node || typeof node !== 'object')
    return node
  const n: Out = {}
  for (const [key, value] of Object.entries(node))
    n[key] = ['enum', 'default', 'example', 'required'].includes(key) ? value : oasToDraft07(value)
  for (const [flag, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (n[flag] === true) {
      n[flag] = n[bound]
      delete n[bound]
    }
    else if (n[flag] === false) {
      delete n[flag]
    }
  }
  if (n.nullable === true && typeof n.type === 'string')
    n.type = [n.type, 'null']
  delete n.nullable
  return n
}

function prepare(out: Out, target: Target, components?: Out): Out {
  if (target !== 'openapi-3.0')
    return structuredClone(out)
  const clean = oasToDraft07({ ...structuredClone(out), ...(components ? { components } : {}) }) as Out
  delete clean.$schema
  return clean
}

function metaProblems(out: Out, target: Target, components?: Out): string[] {
  const ajv = target === 'draft-2020-12' ? ajv2020() : ajv07()
  const clean = prepare(out, target, components)
  try {
    if (!ajv.validateSchema(clean))
      return [`meta-schema: ${ajv.errorsText(ajv.errors)}`]
    ajv.compile(clean)
    return []
  }
  catch (error) {
    return [`ajv compile: ${(error as Error).message}`]
  }
}

function compileFor(out: Out, target: Target, components?: Out) {
  const ajv = target === 'draft-2020-12' ? ajv2020() : ajv07()
  return ajv.compile(prepare(out, target, components))
}

// ─── Structural checks ───────────────────────────────────────────────────────

// Plain JSON all the way down: no hidden markers, accessors, Maps or foreign
// prototypes from the source schema.
function jsonProblems(value: unknown, path = '$', seen = new Set<unknown>()): string[] {
  if (value === null)
    return []
  const type = typeof value
  if (type === 'function' || type === 'symbol' || type === 'bigint' || type === 'undefined')
    return [`${path}: ${type} value`]
  if (type !== 'object')
    return []
  if (seen.has(value))
    return [`${path}: circular or shared reference`]
  seen.add(value)
  const out: string[] = []
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype)
    out.push(`${path}: non-plain prototype`)
  for (const key of Reflect.ownKeys(value as object)) {
    if (typeof key === 'symbol') {
      out.push(`${path}: symbol key`)
      continue
    }
    if (key.startsWith('~'))
      out.push(`${path}: own key ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable && key !== 'length')
      out.push(`${path}.${key}: non-enumerable`)
    if (descriptor.get || descriptor.set)
      out.push(`${path}.${key}: accessor`)
    out.push(...jsonProblems(descriptor.value, `${path}.${key}`, new Set(seen)))
  }
  return out
}

// Subschema positions only, so `default`/`const`/`enum` data is never walked.
function walkSchemas(node: unknown, visit: (n: Out, path: string) => void, path = '#'): void {
  if (!node || typeof node !== 'object')
    return
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchemas(item, visit, `${path}/${index}`))
    return
  }
  visit(node as Out, path)
  for (const [key, value] of Object.entries(node)) {
    if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key) && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value))
        walkSchemas(sub, visit, `${path}/${key}/${name}`)
    }
    else if (['items', 'prefixItems', 'additionalItems', 'additionalProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contains', 'unevaluatedItems', 'unevaluatedProperties'].includes(key)) {
      walkSchemas(value, visit, `${path}/${key}`)
    }
  }
}

// Ajv's meta-schemas accept unknown keywords, so keywords of the wrong
// draft are policed separately.
const only2020 = ['prefixItems', '$defs', 'unevaluatedItems', 'unevaluatedProperties', 'dependentSchemas', 'dependentRequired', '$anchor', '$dynamicRef', 'minContains', 'maxContains']
const only07 = ['additionalItems', 'definitions', 'dependencies', '$recursiveRef']
const oas30Allowed = new Set(['title', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxProperties', 'minProperties', 'required', 'enum', 'type', 'allOf', 'oneOf', 'anyOf', 'not', 'items', 'properties', 'additionalProperties', 'description', 'format', 'default', 'nullable', 'discriminator', 'readOnly', 'writeOnly', 'xml', 'externalDocs', 'example', 'deprecated', '$ref'])

function targetProblems(out: Out, target: Target): string[] {
  const problems: string[] = []
  walkSchemas(out, (n, path) => {
    if (target === 'draft-07') {
      for (const key of only2020) {
        if (key in n)
          problems.push(`${path}: 2020-12-only keyword "${key}"`)
      }
    }
    if (target === 'draft-2020-12') {
      for (const key of only07) {
        if (key in n)
          problems.push(`${path}: draft-07-only keyword "${key}"`)
      }
      if (Array.isArray(n.items))
        problems.push(`${path}: array-form "items"`)
    }
    if (target === 'openapi-3.0') {
      for (const key of Object.keys(n)) {
        if (!oas30Allowed.has(key) && !key.startsWith('x-'))
          problems.push(`${path}: keyword "${key}" is not in the OpenAPI 3.0 Schema Object`)
      }
      if (Array.isArray(n.type) || n.type === 'null')
        problems.push(`${path}: type ${JSON.stringify(n.type)}`)
      if (typeof n.exclusiveMinimum === 'number' || typeof n.exclusiveMaximum === 'number')
        problems.push(`${path}: numeric exclusive bound`)
      if (Array.isArray(n.items))
        problems.push(`${path}: array-form items`)
      if ('items' in n && n.type !== 'array')
        problems.push(`${path}: items without type: array`)
      if (typeof n.$ref === 'string' && !n.$ref.startsWith('#/components/schemas/'))
        problems.push(`${path}: $ref "${n.$ref}" is not a components ref`)
      if ('$ref' in n && Object.keys(n).length > 1)
        problems.push(`${path}: $ref with siblings`)
    }
  })
  return problems
}

// A projection that cuts a flag must not mention it in the schema it emits.
function flagProblems(out: Out, forbid: Array<'readOnly' | 'writeOnly'>): string[] {
  const problems: string[] = []
  walkSchemas(out, (n, path) => {
    for (const flag of forbid) {
      if (n[flag] === true)
        problems.push(`${path}: ${flag}:true present although the projection cuts it`)
    }
  })
  return problems
}

// ─── Schemas under test ──────────────────────────────────────────────────────

const S = Type.Object({
  id: Type.Readonly(Type.String()),
  email: Type.String({ format: 'email' }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
  nick: Type.Optional(Type.String({ default: 'anon' })),
}, { $id: '/user' })

const Tree = Type.Cyclic({
  Node: Type.Object({
    value: Type.String(),
    secret: Type.Writeonly(Type.String()),
    stamp: Type.Readonly(Type.String()),
    children: Type.Array(Type.Ref('Node')),
  }),
}, 'Node')

const Adopted = adopt({
  type: 'object',
  properties: { a: { type: 'string', readOnly: true }, b: { type: 'integer' }, c: { type: 'string', writeOnly: true } },
  required: ['a', 'b'],
} as any)

const Variants = Type.Union([
  Type.Object({ kind: Type.Literal('a'), id: Type.Readonly(Type.String()) }),
  Type.Object({ kind: Type.Literal('b'), pw: Type.Writeonly(Type.String()) }),
])

const Inter = Type.Intersect([
  Type.Object({ id: Type.Readonly(Type.String()) }),
  Type.Object({ pw: Type.Writeonly(Type.String()), n: Type.Number() }),
])

type Flag = 'readOnly' | 'writeOnly'
// `forbid`: flags that must not appear in the emitted schema, input and
// output alike. A full schema validates as its write projection, so its
// readOnly fields are cut.
type Entry = { name: string, schema: TSchema, forbid: Flag[], valid?: unknown[], invalid?: unknown[] }

const matrix: Entry[] = [
  { name: 'full object (readonly/writeonly marks)', schema: S, forbid: ['readOnly'], valid: [{ email: 'a@b.co', password: '12345678' }], invalid: [{ email: 'a@b.co' }, { password: '12345678' }] },
  { name: 'Type.Read(S)', schema: Type.Read(S), forbid: ['writeOnly'], valid: [{ id: '1', email: 'a@b.co' }], invalid: [{ email: 'a@b.co' }] },
  { name: 'Type.Write(S)', schema: Type.Write(S), forbid: ['readOnly'], valid: [{ email: 'a@b.co', password: '12345678' }], invalid: [{ email: 'a@b.co' }] },
  { name: 'Type.Read(Type.Write(S))', schema: Type.Read(Type.Write(S)), forbid: ['readOnly', 'writeOnly'], valid: [{ email: 'a@b.co' }], invalid: [{}] },
  { name: 'Optional + default', schema: Type.Object({ page: Type.Optional(Type.Integer({ default: 1 })), q: Type.String({ default: 'x' }) }), forbid: [], valid: [{ q: 'a' }], invalid: [{ q: 1 }] },
  { name: 'Union (full)', schema: Variants, forbid: ['readOnly'], valid: [{ kind: 'a' }, { kind: 'b', pw: 'x' }], invalid: [{ kind: 'b' }] },
  { name: 'Type.Write(Union)', schema: Type.Write(Variants), forbid: ['readOnly'] },
  { name: 'Type.Read(Union)', schema: Type.Read(Variants), forbid: ['writeOnly'] },
  { name: 'Intersect (full)', schema: Inter, forbid: ['readOnly'], valid: [{ pw: 'x', n: 1 }], invalid: [{ n: 1 }] },
  { name: 'Type.Read(Intersect)', schema: Type.Read(Inter), forbid: ['writeOnly'], valid: [{ id: 'i', n: 1 }], invalid: [{ id: 'i' }] },
  { name: 'Cyclic (full)', schema: Tree, forbid: ['readOnly'], valid: [{ value: 'a', secret: 's', children: [{ value: 'b', secret: 't', children: [] }] }], invalid: [{ value: 'a', secret: 's', children: [{ value: 1, secret: 't', children: [] }] }] },
  { name: 'Type.Read(Cyclic)', schema: Type.Read(Tree), forbid: ['writeOnly'], valid: [{ value: 'a', stamp: 'z', children: [{ value: 'b', stamp: 'z', children: [] }] }], invalid: [{ value: 'a', stamp: 'z', children: [{ stamp: 'z', children: [] }] }] },
  { name: 'Type.Write(Cyclic)', schema: Type.Write(Tree), forbid: ['readOnly'], valid: [{ value: 'a', secret: 's', children: [] }], invalid: [{ value: 'a', children: [] }] },
  { name: 'adopt(plain JSON schema)', schema: Adopted, forbid: ['readOnly'], valid: [{ b: 1, c: 'x' }], invalid: [{ b: 'x' }] },
  { name: 'Type.Write(adopted)', schema: Type.Write(Adopted), forbid: ['readOnly'], valid: [{ b: 1 }], invalid: [{}] },
  { name: 'Type.Read(adopted)', schema: Type.Read(Adopted), forbid: ['writeOnly'], valid: [{ a: 'x', b: 1 }], invalid: [{ b: 1 }] },
  { name: 'Partial(Write(S))', schema: Type.Partial(Type.Write(S)), forbid: ['readOnly'], valid: [{}, { email: 'a@b.co' }], invalid: [{ email: 1 }] },
  { name: 'Pick(Read(S), [id,email])', schema: Type.Pick(Type.Read(S), ['id', 'email']), forbid: ['writeOnly'], valid: [{ id: '1', email: 'a@b.co' }], invalid: [{ id: '1' }] },
  { name: 'Omit(Write(S), [email])', schema: Type.Omit(Type.Write(S), ['email']), forbid: ['readOnly'], valid: [{ password: '12345678' }], invalid: [{ password: 'x' }] },
  { name: 'Record of objects with a readOnly field', schema: Type.Record(Type.String(), Type.Object({ x: Type.Number(), ro: Type.Readonly(Type.String()) })), forbid: ['readOnly'], valid: [{ k: { x: 1 } }], invalid: [{ k: { x: 'a' } }] },
  { name: 'Array of S', schema: Type.Array(S), forbid: ['readOnly'], valid: [[{ email: 'a@b.co', password: '12345678' }]], invalid: [[{ email: 'a@b.co' }]] },
  { name: 'Read(Array of S)', schema: Type.Read(Type.Array(S)), forbid: ['writeOnly'], valid: [[{ id: '1', email: 'a@b.co' }]], invalid: [[{ email: 'a@b.co' }]] },
  { name: 'Tuple', schema: Type.Tuple([Type.String(), Type.Number(), Type.Boolean()]), forbid: [], valid: [['a', 1, true]], invalid: [['a', 1], ['a', 1, true, 4]] },
  { name: 'Nullable union', schema: Type.Union([Type.String(), Type.Null()]), forbid: [], valid: ['a', null], invalid: [1] },
  { name: 'Literal', schema: Type.Literal('x'), forbid: [], valid: ['x'], invalid: ['y'] },
  { name: 'Union of literals', schema: Type.Union([Type.Literal('a'), Type.Literal('b')]), forbid: [], valid: ['a'], invalid: ['c'] },
  { name: 'Same $id used twice', schema: Type.Object({ a: S, b: S }), forbid: ['readOnly'], valid: [{ a: { email: 'a@b.co', password: '12345678' }, b: { email: 'a@b.co', password: '12345678' } }], invalid: [{ a: {}, b: {} }] },
  { name: 'Cyclic nested in an object', schema: Type.Object({ tree: Tree, n: Type.Integer({ exclusiveMinimum: 0, maximum: 5 }) }), forbid: ['readOnly'] },
]

// ─── The matrix: every schema x io x target ──────────────────────────────────

describe('matrix: every schema, io and target', () => {
  for (const entry of matrix) {
    for (const target of targets) {
      for (const io of ios) {
        test(`${entry.name} / ${target} / ${io}`, () => {
          const before = JSON.stringify(entry.schema)
          // OpenAPI 3.0 cannot hold recursion inline: collect it in components.
          const components: Out = {}
          const out = gen(entry.schema, io, target, { components })
          const withComponents = target === 'openapi-3.0' && components.schemas ? components : undefined

          expect(jsonProblems(out)).toEqual([])
          expect(flagProblems(out, entry.forbid)).toEqual([])
          expect(targetProblems(out, target)).toEqual([])
          expect(metaProblems(out, target, withComponents)).toEqual([])
          expect('~standard' in out).toBe(false)

          // Behaviour against validate(): input accepts what the validator
          // accepts, output accepts what the validator hands back.
          const check = compileFor(out, target, withComponents)
          for (const sample of entry.valid ?? []) {
            const result = validate(entry.schema, sample)
            if (io === 'input')
              expect(check(sample)).toBe(true)
            else if (result.success)
              expect(check(result.data)).toBe(true)
          }
          for (const sample of entry.invalid ?? []) {
            if (io === 'input')
              expect(check(sample)).toBe(false)
          }

          const again = gen(entry.schema, io, target, { components: {} })
          expect(again).not.toBe(out)
          expect(again).toEqual(out)
          expect(JSON.stringify(entry.schema)).toBe(before)
        })
      }
    }
  }
})

// ─── Contract ────────────────────────────────────────────────────────────────

describe('contract', () => {
  test('returns a fresh deep copy every call; consumer mutation cannot leak', () => {
    const first = gen(S, 'input', 'draft-07')
    first.properties.email.format = 'MUTATED'
    first.additionalProperties = false
    delete first.required
    const second = gen(S, 'input', 'draft-07')
    expect(second.properties.email.format).toBe('email')
    expect(second.additionalProperties).toBeUndefined()
    expect(second.required).toEqual(['email', 'password'])
  })

  test('does not mutate the source schema or its hidden markers', () => {
    const before = JSON.stringify(Type.Read(S))
    const keysBefore = Reflect.ownKeys(Type.Read(S)).map(String)
    gen(Type.Read(S), 'output', 'openapi-3.0')
    expect(JSON.stringify(Type.Read(S))).toBe(before)
    expect(Reflect.ownKeys(Type.Read(S)).map(String)).toEqual(keysBefore)
  })

  test('the output is a plain object with Object.prototype', () => {
    const out = gen(S, 'output', 'draft-2020-12')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(out.properties)).toBe(Object.prototype)
    expect(Object.keys(out).some(key => key.startsWith('~'))).toBe(false)
  })

  test('the accessor is shared by clones, projections and adopted schemas', () => {
    const adopted = adopt({ type: 'object', properties: { n: { type: 'integer' } } } as any)
    for (const schema of [Type.Read(S), Type.Write(S), Type.Partial(S), Type.Pick(S, ['email']), Type.Readonly(Type.String()), adopted, Type.Read(adopted)])
      expect(typeof gen(schema, 'input', 'draft-07').$schema).toBe('string')
  })

  test('a vendor whose schema carries its own ~standard keeps it', () => {
    const own = { jsonSchema: { input: () => ({}), output: () => ({}) } }
    const foreign = adopt(Object.defineProperty({ type: 'string' }, '~standard', { value: own, enumerable: false }) as any)
    expect((foreign as any)['~standard']).toBe(own)
  })

  test('an unsupported or missing target throws', () => {
    for (const target of ['draft-04', 'draft-2019-09', '', undefined as any])
      expect(() => gen(S, 'input', target)).toThrow(/unsupported JSON Schema target/)
    expect(() => gen(S, 'input', 'draft-04')).toThrow('typebox-standard-schema: unsupported JSON Schema target "draft-04" (supported: draft-2020-12, draft-07, openapi-3.0)')
    expect(() => (S as any)['~standard'].jsonSchema.input(undefined)).toThrow(/unsupported JSON Schema target/)
  })

  test('kinds with no JSON Schema meaning throw instead of leaking type: "bigint"', () => {
    const makes = [() => Type.BigInt(), () => Type.Undefined(), () => Type.Void(), () => Type.Symbol(), () => Type.Function([], Type.Void()), () => Type.Object({ a: Type.BigInt() })]
    for (const make of makes)
      expect(() => gen(make(), 'input', 'draft-2020-12')).toThrow(/no JSON Schema representation/)
    expect(() => gen(Type.BigInt(), 'output', 'draft-07')).toThrow('typebox-standard-schema: type "bigint" has no JSON Schema representation')
  })

  test('a BigInt literal (not JSON-serializable) throws a clear error', () => {
    expect(() => gen(Type.Literal(10n as any), 'input', 'draft-07')).toThrow(/schema is not JSON-serializable/)
  })
})

// ─── Projection semantics ────────────────────────────────────────────────────

describe('projection semantics', () => {
  test('a function default counts as a default, and leaves no trace in the output', () => {
    const S = Type.Object({ id: Type.String({ default: () => 'generated' }), name: Type.String() })
    const input = S['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    const output = S['~standard'].jsonSchema.output({ target: 'draft-07' })

    expect(input.required).toEqual(['name'])
    expect(output.required).toEqual(['id', 'name'])
    expect(JSON.stringify([input, output])).not.toContain('computed-default')
    expect(validate(S, { name: 'a' })).toEqual({ success: true, data: { name: 'a', id: 'generated' } })
  })

  test('a full schema: input and output both describe the write projection', () => {
    for (const io of ios) {
      const out = gen(S, io, 'draft-07')
      expect(Object.keys(out.properties)).toEqual(['email', 'password', 'nick'])
      expect(JSON.stringify(out)).not.toContain('readOnly')
    }
  })

  test('Type.Read keeps readOnly and drops writeOnly fields', () => {
    const out = gen(Type.Read(S), 'output', 'draft-07')
    expect(Object.keys(out.properties)).toEqual(['id', 'email', 'nick'])
    expect(out.properties.id.readOnly).toBe(true)
  })

  test('Type.Read(Type.Write(S)) drops both', () => {
    expect(Object.keys(gen(Type.Read(Type.Write(S)), 'input', 'draft-07').properties)).toEqual(['email', 'nick'])
  })

  test('defaults: input does not require a defaulted property, output does', () => {
    const D = Type.Object({ q: Type.String({ default: 'x' }), n: Type.Number(), page: Type.Optional(Type.Integer({ default: 1 })) })
    expect(gen(D, 'input', 'draft-2020-12').required).toEqual(['n'])
    expect(gen(D, 'output', 'draft-2020-12').required).toEqual(['q', 'n', 'page'])
  })

  test('input accepts what validate() accepts once defaults are filled in', () => {
    const D = Type.Object({ q: Type.String({ default: 'x' }), n: Type.Number() })
    const result = validate(D, { n: 1 })
    expect(result).toEqual({ success: true, data: { q: 'x', n: 1 } })
    expect(compileFor(gen(D, 'input', 'draft-07'), 'draft-07')({ n: 1 })).toBe(true)
    expect(compileFor(gen(D, 'output', 'draft-07'), 'draft-07')({ n: 1 })).toBe(false)
  })

  test('all properties defaulted: no empty required array', () => {
    const D = Type.Object({ q: Type.String({ default: 'x' }) })
    expect('required' in gen(D, 'input', 'draft-07')).toBe(false)
  })

  test('Partial strips defaults, so nothing becomes required in output', () => {
    expect(gen(Type.Partial(Type.Object({ q: Type.String({ default: 'x' }) })), 'output', 'draft-07').required).toBeUndefined()
  })

  test('data values that look like schemas are not rewritten', () => {
    const out = gen(Type.Object({ a: Type.Unknown({ default: { $ref: 'Node', type: 'bigint', $id: 'keep' } }) }), 'input', 'draft-07')
    expect(out.properties.a.default).toEqual({ $ref: 'Node', type: 'bigint', $id: 'keep' })
  })

  test('a property named type, properties or $ref is a property, not a keyword', () => {
    const O = Type.Object({ type: Type.String(), properties: Type.Number(), $ref: Type.String() })
    const out = gen(O, 'input', 'draft-2020-12')
    expect(Object.keys(out.properties)).toEqual(['type', 'properties', '$ref'])
  })

  test('coercion is not advertised: a number stays a number', () => {
    const O = Type.Object({ n: Type.Number() })
    expect(validate(O, { n: '1' }).success).toBe(true)
    expect(gen(O, 'input', 'draft-07').properties.n).toEqual({ type: 'number' })
  })
})

// ─── Definitions and refs ────────────────────────────────────────────────────

describe('definitions and refs', () => {
  test('Cyclic: bare-name refs become JSON pointers per target; the root states its type', () => {
    const d7 = gen(Tree, 'input', 'draft-07')
    expect(d7.type).toBe('object')
    expect(d7.definitions.Node.properties.children.items.$ref).toBe('#/definitions/Node')
    expect(d7.$defs).toBeUndefined()
    const d2020 = gen(Tree, 'input', 'draft-2020-12')
    expect(d2020.$defs.Node.properties.children.items.$ref).toBe('#/$defs/Node')
    expect(d2020.definitions).toBeUndefined()
    expect(JSON.stringify(d2020)).not.toContain('"$id"')
  })

  test('inlineRoot: false keeps a bare root $ref', () => {
    expect(gen(Tree, 'input', 'draft-2020-12', { inlineRoot: false }).$ref).toBe('#/$defs/Node')
    expect(gen(Tree, 'input', 'draft-2020-12', { inlineRoot: true }).$ref).toBeUndefined()
  })

  test('the same Cyclic used twice shares one definition; different ones with one name do not collide', () => {
    const same = gen(Type.Object({ a: Tree, b: Tree }), 'input', 'draft-2020-12')
    expect(Object.keys(same.$defs)).toEqual(['Node'])
    const Other = Type.Cyclic({ Node: Type.Object({ other: Type.Number(), next: Type.Optional(Type.Ref('Node')) }) }, 'Node')
    const diff = gen(Type.Object({ a: Tree, b: Other }), 'input', 'draft-2020-12')
    expect(Object.keys(diff.$defs).sort()).toEqual(['Node', 'Node_2'])
    expect(diff.properties.b.$ref).toBe('#/$defs/Node_2')
    const check = compileFor(diff, 'draft-2020-12')
    expect(check({ a: { value: 'v', secret: 's', children: [] }, b: { other: 1, next: { other: 2 } } })).toBe(true)
    expect(check({ a: { value: 'v', secret: 's', children: [] }, b: { other: 'x' } })).toBe(false)
  })

  test('an adopted schema with definitions and #/definitions refs is translated to $defs', () => {
    const A = adopt({ type: 'object', properties: { n: { $ref: '#/definitions/N' } }, required: ['n'], definitions: { N: { type: 'integer' } } } as any)
    const out = gen(A, 'input', 'draft-2020-12')
    expect(out.properties.n.$ref).toBe('#/$defs/N')
    expect(out.$defs.N).toEqual({ type: 'integer' })
    expect(compileFor(out, 'draft-2020-12')({ n: 1 })).toBe(true)
  })

  test('an adopted foreign $schema header is replaced', () => {
    const A = adopt({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: { n: { type: 'integer' } } } as any)
    expect(gen(A, 'input', 'draft-07').$schema).toBe('http://json-schema.org/draft-07/schema#')
  })

  test('an unresolvable ref throws', () => {
    expect(() => gen(Type.Object({ a: Type.Ref('Nope') }), 'input', 'draft-07')).toThrow('typebox-standard-schema: cannot resolve $ref "Nope"')
  })

  test('$id is stripped by default (duplicates would break Ajv) and kept with keepIds', () => {
    expect('$id' in gen(S, 'input', 'draft-07')).toBe(false)
    expect(gen(S, 'input', 'draft-07', { keepIds: true }).$id).toBe('/user')
    expect(gen(S, 'input', 'draft-07', { keepIds: false }).$id).toBeUndefined()
  })
})

// ─── Target differences ──────────────────────────────────────────────────────

describe('draft differences', () => {
  const T = Type.Tuple([Type.String(), Type.Number()])

  test('tuple: draft-07 keeps items[] + additionalItems, 2020-12 uses prefixItems + items:false', () => {
    const d7 = gen(T, 'input', 'draft-07')
    expect(d7.items).toHaveLength(2)
    expect(d7.additionalItems).toBe(false)
    const d2020 = gen(T, 'input', 'draft-2020-12')
    expect(d2020.prefixItems).toHaveLength(2)
    expect(d2020.items).toBe(false)
    expect('additionalItems' in d2020).toBe(false)
    for (const [out, target] of [[d7, 'draft-07'], [d2020, 'draft-2020-12']] as const) {
      const check = compileFor(out, target)
      expect(check(['a', 1])).toBe(true)
      expect(check(['a', 1, 2])).toBe(false)
      expect(check([1, 'a'])).toBe(false)
    }
  })

  test('an adopted 2020-12 schema (prefixItems, dependentRequired) converts to draft-07', () => {
    const A = adopt({ type: 'object', properties: { t: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } }, a: { type: 'string' }, b: { type: 'string' } }, dependentRequired: { a: ['b'] } } as any)
    const out = gen(A, 'input', 'draft-07')
    expect(out.properties.t.items).toEqual([{ type: 'string' }])
    expect(out.properties.t.additionalItems).toEqual({ type: 'number' })
    expect(out.dependencies).toEqual({ a: ['b'] })
    const check = compileFor(out, 'draft-07')
    expect(check({ a: 'x' })).toBe(false)
    expect(check({ a: 'x', b: 'y', t: ['s', 1, 2] })).toBe(true)
  })

  test('adopted draft-07 dependencies convert to 2020-12', () => {
    const A = adopt({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, dependencies: { a: ['b'] } } as any)
    const out = gen(A, 'input', 'draft-2020-12')
    expect(out.dependentRequired).toEqual({ a: ['b'] })
    expect(out.dependencies).toBeUndefined()
  })

  test('draft-07: keywords with no equivalent throw', () => {
    const A = adopt({ type: 'object', properties: { a: { type: 'string' } }, unevaluatedProperties: false } as any)
    expect(() => gen(A, 'input', 'draft-07')).toThrow('typebox-standard-schema: "unevaluatedProperties" cannot be expressed in draft-07')
    expect(gen(A, 'input', 'draft-2020-12').unevaluatedProperties).toBe(false)
  })

  test('draft-07: $ref with siblings is wrapped in allOf', () => {
    const A = adopt({ type: 'object', properties: { a: { $ref: '#/definitions/N', description: 'x' } }, definitions: { N: { type: 'integer' } } } as any)
    expect(gen(A, 'input', 'draft-07').properties.a).toEqual({ description: 'x', allOf: [{ $ref: '#/definitions/N' }] })
    expect(gen(A, 'input', 'draft-2020-12').properties.a).toEqual({ $ref: '#/$defs/N', description: 'x' })
  })

  test('if/then/else is fine in the drafts and throws for openapi-3.0', () => {
    const D = adopt({ type: 'object', if: { properties: { kind: { const: 'a' } } }, then: { required: ['extra'] } } as any)
    expect(() => gen(D, 'input', 'draft-2020-12')).not.toThrow()
    expect(() => gen(D, 'input', 'draft-07')).not.toThrow()
    expect(() => gen(D, 'input', 'openapi-3.0')).toThrow('typebox-standard-schema: "if" cannot be expressed in OpenAPI 3.0')
  })
})

describe('openapi-3.0', () => {
  test('const -> enum, nullable, numeric bounds, no $schema or $id', () => {
    const O = Type.Object({ lit: Type.Literal('x'), maybe: Type.Union([Type.String(), Type.Null()]), n: Type.Integer({ exclusiveMinimum: 0, exclusiveMaximum: 10 }), only: Type.Null() })
    const out = gen(O, 'input', 'openapi-3.0')
    expect(out.properties.lit).toEqual({ type: 'string', enum: ['x'] })
    expect(out.properties.maybe).toEqual({ type: 'string', nullable: true })
    expect(out.properties.n).toEqual({ type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: true })
    expect(out.properties.only).toEqual({ nullable: true, enum: [null] })
    expect(targetProblems(out, 'openapi-3.0')).toEqual([])
    expect('$schema' in out).toBe(false)
  })

  test('a nullable object keeps its type and gains nullable', () => {
    const out = gen(Type.Union([Type.Object({ a: Type.String() }), Type.Null()]), 'input', 'openapi-3.0')
    expect(out.type).toBe('object')
    expect(out.nullable).toBe(true)
  })

  test('Record -> additionalProperties; Tuple -> items anyOf with a fixed length', () => {
    expect(gen(Type.Record(Type.String(), Type.Number()), 'input', 'openapi-3.0')).toEqual({ type: 'object', additionalProperties: { type: 'number' } })
    expect(gen(Type.Tuple([Type.String(), Type.Number()]), 'input', 'openapi-3.0')).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 2, maxItems: 2 })
  })

  test('non-recursive definitions are inlined; recursion throws unless components are provided', () => {
    const Shared = Type.Cyclic({ Leaf: Type.Object({ v: Type.Number() }) }, 'Leaf')
    const out = gen(Type.Object({ a: Shared }), 'input', 'openapi-3.0')
    expect(JSON.stringify(out)).not.toContain('$ref')
    expect(() => gen(Tree, 'input', 'openapi-3.0')).toThrow(/^typebox-standard-schema: recursive schema "Node" cannot be expressed in OpenAPI 3.0 without components/)
    const components: Out = {}
    const withComponents = gen(Tree, 'input', 'openapi-3.0', { components })
    expect(Object.keys(components.schemas)).toEqual(['Node'])
    expect(withComponents.properties.children.items.$ref).toBe('#/components/schemas/Node')
  })

  test('a components bag that already holds a different schema under a name throws', () => {
    const components: Out = { schemas: { Node: { type: 'string' } } }
    expect(() => gen(Tree, 'input', 'openapi-3.0', { components })).toThrow('typebox-standard-schema: components.schemas.Node already holds a different schema')
    const compatible: Out = {}
    gen(Tree, 'input', 'openapi-3.0', { components: compatible })
    expect(() => gen(Tree, 'input', 'openapi-3.0', { components: compatible })).not.toThrow()
  })
})
