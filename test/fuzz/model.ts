// Random schemas for property-based testing, shared by the seeded test in
// src/property.test.ts and the fuzzer in test/fuzz/run.ts.
//
// A schema is generated as a small model first, then turned into a real
// schema with the public `Type` API (build) and into the same schema as
// source code (code), so a failure can be printed as a runnable repro.
//
// Two modes:
//
// - strict: objects, arrays, records, unions told apart by a literal `kind`,
//   intersections of objects with disjoint keys, Readonly/Writeonly marks at
//   any depth, defaults, additionalProperties: false. For these the expected
//   result of every projection is unambiguous (`expected`).
// - broad: strict plus Type.Cyclic (each with its own definition name) and
//   Type.Dependent, where only properties that need no oracle are checked.

import type { TSchema } from '../../src/index'
import { Type } from '../../src/index'

export type Flag = 'readOnly' | 'writeOnly'
export type Mode = 'strict' | 'broad'

export type Model
  = | { t: 'string' | 'number' | 'boolean' }
    | { t: 'object', props: Prop[], strict: boolean }
    | { t: 'array', item: Model }
    | { t: 'record', value: Model }
    | { t: 'union', branches: { kind: string, props: Prop[] }[] }
    | { t: 'intersect', members: Prop[][] }
    | { t: 'cyclic', name: string, props: Prop[] }
    | { t: 'dependent', condition: Prop[], then: Prop[], otherwise: Prop[] }

export type Prop = { key: string, model: Model, optional: boolean, mark?: Flag, fallback?: string }

// mulberry32: small, fast, and the same sequence for the same seed everywhere.
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generate(next: () => number, mode: Mode = 'strict'): Model {
  let keys = 0
  let names = 0
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const mark = (): Flag | undefined => next() < 0.3 ? pick(['readOnly', 'writeOnly'] as const) : undefined

  // typebox's Default doesn't reach into record values, so no defaults there.
  function props(depth: number, count: number, defaults: boolean): Prop[] {
    return Array.from({ length: count }, () => {
      const model = node(depth + 1, defaults)
      const fallback = defaults && model.t === 'string' && next() < 0.15 ? 'dflt' : undefined
      return { key: `k${keys++}`, model, optional: next() < 0.3, mark: mark(), fallback }
    })
  }

  function node(depth: number, defaults: boolean): Model {
    const roll = depth > 2 ? 0 : next()
    if (roll < 0.36)
      return { t: pick(['string', 'number', 'boolean'] as const) }
    if (roll < 0.58)
      return { t: 'object', props: props(depth, 1 + Math.floor(next() * 3), defaults), strict: next() < 0.25 }
    if (roll < 0.67)
      return { t: 'array', item: node(depth + 1, defaults) }
    if (roll < 0.73)
      return { t: 'record', value: node(depth + 1, false) }
    if (roll < 0.82)
      return { t: 'union', branches: ['a', 'b'].map(kind => ({ kind, props: props(depth, 1 + Math.floor(next() * 2), defaults) })) }
    if (roll < 0.9 || mode === 'strict')
      return { t: 'intersect', members: [props(depth, 1 + Math.floor(next() * 2), defaults), props(depth, 1 + Math.floor(next() * 2), defaults)] }
    if (roll < 0.95)
      return { t: 'cyclic', name: `N${names++}`, props: props(depth, 1 + Math.floor(next() * 2), defaults) }
    // A mark inside `if` is part of the feature: it cuts that field from
    // whichever branch the value takes.
    const condition: Prop[] = next() < 0.4 ? [{ key: `k${keys++}`, model: { t: 'string' }, optional: true, mark: mark() }] : []
    return { t: 'dependent', condition, then: props(depth, 1 + Math.floor(next() * 2), defaults), otherwise: props(depth, 1 + Math.floor(next() * 2), defaults) }
  }

  return { t: 'object', props: props(0, 2 + Math.floor(next() * 3), true), strict: next() < 0.25 }
}

export function hasKind(model: Model, kind: Model['t']): boolean {
  if (model.t === kind)
    return true
  const inProps = (props: Prop[]): boolean => props.some(prop => hasKind(prop.model, kind))
  switch (model.t) {
    case 'object':
    case 'cyclic': return inProps(model.props)
    case 'array': return hasKind(model.item, kind)
    case 'record': return hasKind(model.value, kind)
    case 'union': return model.branches.some(branch => inProps(branch.props))
    case 'intersect': return model.members.some(inProps)
    case 'dependent': return inProps(model.condition) || inProps(model.then) || inProps(model.otherwise)
    default: return false
  }
}

// ─── Model → schema, and the same schema as source code ──────────────────────

function properties(props: Prop[]): Record<string, TSchema> {
  return Object.fromEntries(props.map((prop) => {
    let schema = build(prop.model, prop.fallback)
    if (prop.mark === 'readOnly')
      schema = Type.Readonly(schema)
    if (prop.mark === 'writeOnly')
      schema = Type.Writeonly(schema)
    return [prop.key, prop.optional ? Type.Optional(schema) : schema]
  }))
}

export function build(model: Model, fallback?: string): TSchema {
  switch (model.t) {
    case 'string': return Type.String(fallback === undefined ? {} : { default: fallback })
    case 'number': return Type.Number()
    case 'boolean': return Type.Boolean()
    case 'object': return Type.Object(properties(model.props), model.strict ? { additionalProperties: false } : {})
    case 'array': return Type.Array(build(model.item))
    case 'record': return Type.Record(Type.String(), build(model.value))
    case 'union': return Type.Union(model.branches.map(branch => Type.Object({ kind: Type.Literal(branch.kind), ...properties(branch.props) })))
    case 'intersect': return Type.Intersect(model.members.map(member => Type.Object(properties(member))))
    case 'cyclic': return Type.Cyclic({
      [model.name]: Type.Object({ ...properties(model.props), next: Type.Optional(Type.Union([Type.Ref(model.name), Type.Null()])) }),
    }, model.name)
    case 'dependent': return Type.Dependent(
      Type.Object({ kind: Type.Literal('x'), ...properties(model.condition) }),
      Type.Object({ kind: Type.Literal('x'), ...properties(model.then) }),
      Type.Object({ kind: Type.String(), ...properties(model.otherwise) }),
    )
  }
}

function propertiesCode(props: Prop[]): string {
  return props.map((prop) => {
    let schema = code(prop.model, prop.fallback)
    if (prop.mark === 'readOnly')
      schema = `Type.Readonly(${schema})`
    if (prop.mark === 'writeOnly')
      schema = `Type.Writeonly(${schema})`
    return `${prop.key}: ${prop.optional ? `Type.Optional(${schema})` : schema}`
  }).join(', ')
}

export function code(model: Model, fallback?: string): string {
  switch (model.t) {
    case 'string': return fallback === undefined ? 'Type.String()' : `Type.String({ default: ${JSON.stringify(fallback)} })`
    case 'number': return 'Type.Number()'
    case 'boolean': return 'Type.Boolean()'
    case 'object': return `Type.Object({ ${propertiesCode(model.props)} }${model.strict ? ', { additionalProperties: false }' : ''})`
    case 'array': return `Type.Array(${code(model.item)})`
    case 'record': return `Type.Record(Type.String(), ${code(model.value)})`
    case 'union': return `Type.Union([${model.branches.map(branch => `Type.Object({ kind: Type.Literal(${JSON.stringify(branch.kind)}), ${propertiesCode(branch.props)} })`).join(', ')}])`
    case 'intersect': return `Type.Intersect([${model.members.map(member => `Type.Object({ ${propertiesCode(member)} })`).join(', ')}])`
    case 'cyclic': return `Type.Cyclic({ ${model.name}: Type.Object({ ${propertiesCode(model.props)}, next: Type.Optional(Type.Union([Type.Ref('${model.name}'), Type.Null()])) }) }, '${model.name}')`
    case 'dependent': return `Type.Dependent(Type.Object({ kind: Type.Literal('x'), ${propertiesCode(model.condition)} }), Type.Object({ kind: Type.Literal('x'), ${propertiesCode(model.then)} }), Type.Object({ kind: Type.String(), ${propertiesCode(model.otherwise)} }))`
  }
}

// ─── Values valid against the full schema ────────────────────────────────────
// Required fields with a default are sometimes left out: Default fills them.

export function value(model: Model, next: () => number, depth = 0): unknown {
  const fill = (props: Prop[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const prop of props) {
      if (prop.optional && next() < 0.4)
        continue
      if (prop.fallback !== undefined && next() < 0.3)
        continue
      out[prop.key] = value(prop.model, next, depth + 1)
    }
    return out
  }
  switch (model.t) {
    case 'string': return `s${Math.floor(next() * 100)}`
    case 'number': return Math.floor(next() * 100)
    case 'boolean': return next() < 0.5
    case 'object': return fill(model.props)
    case 'array': return Array.from({ length: Math.floor(next() * 3) }, () => value(model.item, next, depth + 1))
    case 'record': return Object.fromEntries(Array.from({ length: Math.floor(next() * 3) }, (_, i) => [`r${i}`, value(model.value, next, depth + 1)]))
    case 'union': {
      const branch = model.branches[Math.floor(next() * model.branches.length)]!
      return { kind: branch.kind, ...fill(branch.props) }
    }
    case 'intersect': return Object.assign({}, ...model.members.map(fill))
    case 'cyclic': {
      const out = fill(model.props)
      if (depth < 6 && next() < 0.5)
        out.next = value(model, next, depth + 1)
      return out
    }
    case 'dependent': {
      // The `then` branch needs the condition met; its marked field, when
      // present, is a string as the condition declares it.
      if (next() < 0.5)
        return { kind: 'x', ...fill(model.condition), ...fill(model.then) }
      return { kind: 'y', ...fill(model.otherwise) }
    }
  }
}

// ─── The oracle (strict mode only) ───────────────────────────────────────────
// What a result must be: the input minus every field marked with a `cut`
// flag, plus any default the input left out.

export function expected(model: Model, input: unknown, cut: readonly Flag[]): unknown {
  const shape = (props: Prop[], source: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...extra }
    for (const prop of props) {
      if (prop.mark && cut.includes(prop.mark))
        continue
      if (Object.hasOwn(source, prop.key))
        out[prop.key] = expected(prop.model, source[prop.key], cut)
      else if (prop.fallback !== undefined)
        out[prop.key] = prop.fallback
    }
    return out
  }
  switch (model.t) {
    case 'object': return shape(model.props, input as Record<string, unknown>)
    case 'array': return (input as unknown[]).map(item => expected(model.item, item, cut))
    case 'record': return Object.fromEntries(Object.entries(input as object).map(([key, item]) => [key, expected(model.value, item, cut)]))
    case 'union': {
      const source = input as Record<string, unknown>
      const branch = model.branches.find(candidate => candidate.kind === source.kind)!
      return shape(branch.props, source, { kind: source.kind })
    }
    case 'intersect': return shape(model.members.flat(), input as Record<string, unknown>)
    case 'cyclic':
    case 'dependent': throw new Error(`no oracle for ${model.t} — strict mode never generates it`)
    default: return input
  }
}
