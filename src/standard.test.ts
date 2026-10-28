import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import type { JsonSchemaOptions, JsonSchemaTarget } from './index'
import { describe, expect, test } from 'bun:test'
import { expectTypeOf } from 'expect-type'
import { adopt, Type, validate } from './index'

// Conformance against the official Standard Schema v1 types and the inference
// they enable in consumers (tRPC, Hono, TanStack Form all infer through
// StandardSchemaV1.InferInput/InferOutput). The type-level assertions fail
// under `bun run check`, not at runtime.

const User = Type.Object({
  id: Type.Readonly(Type.String()),
  email: Type.String({ format: 'email' }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
})

describe('Standard Schema v1 conformance', () => {
  test('schemas are assignable to StandardSchemaV1', () => {
    // Assignment is the conformance check; the runtime expect just anchors it.
    const asStandard: StandardSchemaV1 = User
    const primitive: StandardSchemaV1 = Type.String()
    const projection: StandardSchemaV1 = Type.Read(User)
    const adopted: StandardSchemaV1 = adopt({ type: 'string' })

    expect([asStandard, primitive, projection, adopted]).toBeDefined()
  })

  test('the props shape matches the spec field for field', () => {
    const props = User['~standard']

    expect(props.version).toBe(1)
    expect(props.vendor).toBe('typebox')
    expect(typeof props.validate).toBe('function')
    // `types` is type-level only — never materialized at runtime.
    expect('types' in props).toBe(false)
  })

  test('InferOutput of a full schema is the write shape it validates', () => {
    expectTypeOf<StandardSchemaV1.InferOutput<typeof User>>().toEqualTypeOf<{
      email: string
      password: string
    }>()
    expectTypeOf<StandardSchemaV1.InferInput<typeof User>>().toEqualTypeOf<{
      email: string
      password: string
    }>()
  })

  test('InferOutput of a projection is that projection', () => {
    const PublicUser = Type.Read(User)

    expect(PublicUser).toBeDefined()
    expectTypeOf<StandardSchemaV1.InferOutput<typeof PublicUser>>().toEqualTypeOf<{
      id: string
      email: string
    }>()
  })

  test('InferOutput of primitives and unions resolves', () => {
    const Locale = Type.Union([Type.Literal('en'), Type.Literal('ru')])

    expect(Locale).toBeDefined()
    expectTypeOf<StandardSchemaV1.InferOutput<typeof Locale>>().toEqualTypeOf<'en' | 'ru'>()
    expectTypeOf<StandardSchemaV1.InferOutput<ReturnType<typeof Type.String>>>().toEqualTypeOf<string>()
  })

  test('InferOutput survives recursion (Type.Cyclic)', () => {
    const Tree = Type.Cyclic({
      Node: Type.Object({
        value: Type.String(),
        children: Type.Array(Type.Ref('Node')),
      }),
    }, 'Node')

    expect(Tree).toBeDefined()
    type Out = StandardSchemaV1.InferOutput<typeof Tree>
    expectTypeOf<Out>().toEqualTypeOf<{ value: string, children: Out[] }>()
  })

  test('~standard.validate narrows to the receiver-specific value type', () => {
    const result = User['~standard'].validate({ email: 'a@b.c', password: 'longenough' })

    if ('issues' in result) {
      throw new Error(`expected success, got ${JSON.stringify(result.issues)}`)
    }
    else {
      expectTypeOf(result.value).toEqualTypeOf<{ email: string, password: string }>()
      expect(result.value).toEqual({ email: 'a@b.c', password: 'longenough' })
    }
  })

  test('the sync-only result contract holds (spec allows Promises; we never return one)', () => {
    const result = User['~standard'].validate({})

    expect(result).not.toBeInstanceOf(Promise)
    expect('issues' in result).toBe(true)
  })

  test('issues carry message and path exactly as the spec shapes them', () => {
    const result = Type.Object({ a: Type.String() })['~standard'].validate({})

    if ('issues' in result) {
      const [issue] = result.issues
      expect(typeof issue?.message).toBe('string')
      expect(issue?.path).toEqual(['a'])
    }
    else {
      throw new Error('expected issues')
    }
  })

  test('validate() and ~standard.validate() agree on the same input', () => {
    const direct = validate(User, { email: 'a@b.c', password: 'longenough' })
    const standard = User['~standard'].validate({ email: 'a@b.c', password: 'longenough' })

    expect(direct.success).toBe(true)
    if (direct.success && !('issues' in standard))
      expect(standard.value).toEqual(direct.data)
  })
})

// Standard JSON Schema: the `jsonSchema` half of the same `~standard` object.
// Behaviour is covered in json-schema.test.ts; here only the type contract.
describe('Standard JSON Schema conformance', () => {
  test('schemas are assignable to StandardJSONSchemaV1 and to the intersection', () => {
    const json: StandardJSONSchemaV1 = User
    const both: StandardSchemaV1 & StandardJSONSchemaV1 = User
    const primitive: StandardSchemaV1 & StandardJSONSchemaV1 = Type.String()
    const projection: StandardSchemaV1 & StandardJSONSchemaV1 = Type.Read(User)
    const adopted: StandardSchemaV1 & StandardJSONSchemaV1 = adopt({ type: 'string' })

    expect([json, both, primitive, projection, adopted]).toBeDefined()
  })

  test('types carries the same input and output as the validation half', () => {
    expectTypeOf<StandardJSONSchemaV1.InferInput<typeof User>>().toEqualTypeOf<{ email: string, password: string }>()
    expectTypeOf<StandardJSONSchemaV1.InferOutput<typeof User>>().toEqualTypeOf<{ email: string, password: string }>()

    const PublicUser = Type.Read(User)

    expect(PublicUser).toBeDefined()
    expectTypeOf<StandardJSONSchemaV1.InferOutput<typeof PublicUser>>().toEqualTypeOf<{ id: string, email: string }>()
  })

  test('a Standard Schema without jsonSchema is not a StandardJSONSchemaV1', () => {
    type ValidateOnly = StandardSchemaV1<unknown, string>

    expectTypeOf<ValidateOnly>().not.toExtend<StandardJSONSchemaV1>()
    expectTypeOf<typeof User>().toExtend<StandardJSONSchemaV1>()
    expectTypeOf<typeof User>().toExtend<StandardSchemaV1 & StandardJSONSchemaV1>()
  })

  test('input and output take { target, libraryOptions } and return a plain record', () => {
    const { jsonSchema } = User['~standard']

    expectTypeOf(jsonSchema.input).parameter(0).toEqualTypeOf<JsonSchemaOptions>()
    expectTypeOf(jsonSchema.output).returns.toEqualTypeOf<Record<string, unknown>>()
    expectTypeOf<JsonSchemaTarget>().toExtend<string>()
    expectTypeOf<'draft-07'>().toExtend<JsonSchemaTarget>()
    expect(jsonSchema.input({ target: 'draft-07' })).toBeDefined()
  })
})
