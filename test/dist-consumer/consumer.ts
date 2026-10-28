// Conformance of the *built package* — the thing consumers actually install.
//
// src/standard.test.ts asserts the same promises against the sources; this
// file asserts them against `dist/`, reached the way an installed consumer
// reaches it: by package name, through the `exports` map (a self-reference —
// the nearest package.json is this repo's, and its name is the specifier),
// resolved with `moduleResolution: bundler` and no `paths` shortcut.
//
// What only this level can catch: the `declare module 'typebox'` augmentation
// failing to survive the declaration rollup, `~standard.types` degrading to
// `any`/`unknown` in the bundled .d.mts, or a stale `dist/` being shipped
// while the sources are green. All three look identical from the outside —
// StandardSchemaV1.InferInput/InferOutput silently widen and every consumer
// generic constrained by `StandardSchemaV1` (SvelteKit remote functions,
// tRPC, Hono, TanStack Form) hands the handler an untyped argument.

import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { expectTypeOf } from 'expect-type'
import { Type } from 'typebox-standard-schema'

// How consumers actually take a schema: a generic constrained by the spec
// interface, inferring the handler argument through InferOutput. If the
// augmentation is missing the constraint fails; if `types` is untyped the
// argument silently becomes `any` — this signature catches both.
declare function remote<Schema extends StandardSchemaV1, Output>(
  schema: Schema,
  handler: (data: StandardSchemaV1.InferOutput<Schema>) => Output,
): Output

// --- plain object ----------------------------------------------------------

const Plain = Type.Object({ a: Type.String(), b: Type.Integer() })

expectTypeOf<StandardSchemaV1.InferOutput<typeof Plain>>().toEqualTypeOf<{ a: string, b: number }>()
expectTypeOf<StandardSchemaV1.InferInput<typeof Plain>>().toEqualTypeOf<{ a: string, b: number }>()

remote(Plain, (data) => {
  expectTypeOf(data).toEqualTypeOf<{ a: string, b: number }>()
})

// --- evaluated intersection ------------------------------------------------

const Evaluated = Type.Evaluate(Type.Intersect([
  Type.Object({ a: Type.String() }),
  Type.Object({ b: Type.Integer() }),
]))

remote(Evaluated, (data) => {
  expectTypeOf(data.a).toEqualTypeOf<string>()
  expectTypeOf(data.b).toEqualTypeOf<number>()
})

// --- projections are receiver-aware ---------------------------------------

const User = Type.Object({
  id: Type.Readonly(Type.String()),
  email: Type.String({ format: 'email' }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
})

// The full schema advertises what it validates: the write shape.
remote(User, (data) => {
  expectTypeOf(data).toEqualTypeOf<{ email: string, password: string }>()
})

remote(Type.Read(User), (data) => {
  expectTypeOf(data).toEqualTypeOf<{ id: string, email: string }>()
})

remote(Type.Write(User), (data) => {
  expectTypeOf(data).toEqualTypeOf<{ email: string, password: string }>()
})

// --- optional / union / literal members ------------------------------------

const Mixed = Type.Object({
  nickname: Type.Optional(Type.String()),
  locale: Type.Union([Type.Literal('en'), Type.Literal('ru')]),
})

remote(Mixed, (data) => {
  expectTypeOf(data).toEqualTypeOf<{ nickname?: string, locale: 'en' | 'ru' }>()
})

// --- primitives ------------------------------------------------------------

remote(Type.String(), (data) => {
  expectTypeOf(data).toEqualTypeOf<string>()
})

// --- Standard JSON Schema --------------------------------------------------

// The same consumer shape for the JSON Schema half: a generic constrained by
// the spec interface, inferring through StandardJSONSchemaV1.InferInput. The
// intersection is what AI SDK / MCP-style consumers accept.
declare function tool<Schema extends StandardSchemaV1 & StandardJSONSchemaV1>(
  schema: Schema,
  handler: (data: StandardJSONSchemaV1.InferInput<Schema>) => void,
): Record<string, unknown>

expectTypeOf(User).toExtend<StandardJSONSchemaV1>()
expectTypeOf(Type.Read(User)).toExtend<StandardSchemaV1 & StandardJSONSchemaV1>()

tool(User, (data) => {
  expectTypeOf(data).toEqualTypeOf<{ email: string, password: string }>()
})

tool(Type.Read(User), (data) => {
  expectTypeOf(data).toEqualTypeOf<{ id: string, email: string }>()
})

// A validate-only Standard Schema is rejected.
// @ts-expect-error -- no `jsonSchema` on the props
tool({} as StandardSchemaV1<unknown, string>, () => {})

expectTypeOf(User['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqualTypeOf<Record<string, unknown>>()

// The assertions above are the test; nothing here runs. The export keeps the
// file a module under `verbatimModuleSyntax` and `isolatedModules`.
export {}
