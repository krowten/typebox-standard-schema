// Convert and Default, the two coercion stages of the validation pipeline,
// done the way typebox's Value.Convert/Value.Default do them — except for
// unions. typebox resolves a union by running the whole stage on a fresh
// copy of the value once per branch, recursively: on a recursive union every
// level multiplies the work by the number of branches, and a payload of a
// couple of hundred bytes takes seconds (valid data included, once the
// matching branch isn't the first). Here a value is never copied to be
// tried: both stages are pure, copy-on-write, so a (schema, value) result can
// be memoized for the call and every pair is worked out once; and branches a
// value can't possibly match are ruled out before any work.
//
// Leaf kinds (String, Number, Literal, ...) convert from strings only, by
// Ajv's coerceTypes rules (toType below); those without a JSON type (Enum,
// BigInt) still by typebox itself. Composite kinds are
// walked here, following typebox's own rules for each, with one deliberate
// difference: an object's additionalProperties values are converted even
// when it declares no properties (typebox skips them then, by accident of
// how it loops).

import type { TSchema } from 'typebox'
import type { Validator } from 'typebox/compile'
import OriginalType from 'typebox'
import { Compile } from 'typebox/compile'
import Value from 'typebox/value'
import { compiledCache } from './format'

export type Defs = Readonly<Record<string, TSchema>>
type Node = Record<string, unknown>
type Stage = (schema: TSchema, value: unknown, defs: Defs) => unknown

const leafKinds = new Set(['BigInt', 'Boolean', 'Enum', 'Integer', 'Literal', 'Null', 'Number', 'String', 'TemplateLiteral', 'Undefined', 'Void'])

export function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNode(value: unknown): value is TSchema {
  return typeof value === 'object' && value !== null
}

export function kindOf(schema: TSchema): unknown {
  return (schema as Node)['~kind']
}

// A copy that can take any key — '__proto__' included — as an own property.
function define(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function copyOf(source: object): Record<string, unknown> {
  if (Array.isArray(source))
    return source.slice() as unknown as Record<string, unknown>
  const copy = Object.create(Object.getPrototypeOf(source)) as Record<string, unknown>
  for (const key of Object.keys(source))
    define(copy, key, (source as Record<string, unknown>)[key])
  return copy
}

// Lexical $defs (or draft-07 `definitions`) of a node — a Type.Cyclic, or the
// root of an adopted JSON Schema — merged into the names in scope, the same
// context typebox threads through. Each definition is reachable by its bare
// name (Type.Ref) and by the pointers JSON Schema uses (#/$defs/Name,
// #/definitions/Name): typebox resolves a ref in a compiled context by its
// literal string. One object per (scope, node), so compiled validators cache.
const scopes = new WeakMap<Defs, WeakMap<TSchema, Defs>>()

function addDefinitions(out: Record<string, TSchema>, node: Node, keep: boolean): void {
  for (const container of ['$defs', 'definitions'] as const) {
    if (!isDictionary(node[container]))
      continue
    for (const [name, definition] of Object.entries(node[container] as Record<string, TSchema>)) {
      const pointer = name.replace(/~/g, '~0').replace(/\//g, '~1')
      for (const key of [name, `#/$defs/${pointer}`, `#/definitions/${pointer}`]) {
        if (!keep || !(key in out))
          out[key] = definition
      }
    }
  }
}

function hasDefinitions(node: Node): boolean {
  return isDictionary(node.$defs) || isDictionary(node.definitions)
}

export function enter(defs: Defs, schema: TSchema): Defs {
  let byNode = scopes.get(defs)
  if (!byNode)
    scopes.set(defs, byNode = new WeakMap())
  let merged = byNode.get(schema)
  if (!merged) {
    const out = Object.assign(Object.create(null), defs) as Record<string, TSchema>
    addDefinitions(out, schema as Node, false)
    merged = liftNested(out)
    byNode.set(schema, merged)
  }
  return merged
}

// The names in scope inside `schema`: its own definitions added, if it has any.
export function scopeOf(schema: TSchema, defs: Defs): Defs {
  return hasDefinitions(schema as Node) ? enter(defs, schema) : defs
}

// typebox resolves the refs of a subschema compiled with a context against
// that context only, not against the $defs of a Type.Cyclic nested inside one
// of its definitions: Compile({ N0 }, Ref('N0')) rejects valid data when N0
// holds a Cyclic of its own. Lift every nested definition into the context so
// such a branch checks as it does inside the whole schema. Names already in
// scope win — two Type.Cyclic sharing a definition name are unsupported anyway.
const dataKeywords = new Set(['default', 'const', 'enum', 'examples'])

export function liftNested(defs: Defs): Defs {
  const out = defs as Record<string, TSchema>
  const seen = new WeakSet<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value))
      return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    addDefinitions(out, value as Node, true)
    const node = value as Node
    for (const [key, child] of Object.entries(node)) {
      if (!dataKeywords.has(key))
        visit(child)
    }
  }
  Object.values(defs).forEach(visit)
  return out
}

const validators = compiledCache<TSchema, WeakMap<Defs, Validator>>()

export function check(schema: TSchema, defs: Defs, value: unknown): boolean {
  let byDefs = validators().get(schema)
  if (!byDefs)
    validators().set(schema, byDefs = new WeakMap())
  let validator = byDefs.get(defs)
  if (!validator)
    byDefs.set(defs, validator = Compile(defs as Record<string, TSchema>, schema))
  return validator.Check(value)
}

function typeFits(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'null': return value === null
    case 'object': return isDictionary(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number'
    case 'integer': return Number.isInteger(value)
    default: return true
  }
}

// Whether a union branch can't match `value` even after coercion: a
// different JSON container type, or a property `const` (a tagged union's
// discriminator) the value already contradicts. Primitives are left alone —
// Convert may turn '42' into 42 — and so is an undefined value a branch
// could default into existence. `settled`: coercion is over (error
// reporting), so any JSON type mismatch rules a branch out.
export function ruledOut(schema: TSchema, defs: Defs, value: unknown, settled = false, depth = 0): boolean {
  const node = schema as Node
  if (depth > 8 || value === undefined)
    return false
  if (typeof node.$ref === 'string')
    return isNode(defs[node.$ref]) && ruledOut(defs[node.$ref]!, defs, value, settled, depth + 1)
  // Before coercion only an object branch is decided: Convert may wrap a
  // string into an array.
  const decidable = settled ? typeof node.type === 'string' : node.type === 'object'
  if (decidable && !typeFits(node.type, value))
    return true
  if (isDictionary(value) && isDictionary(node.properties)) {
    for (const [key, property] of Object.entries(node.properties)) {
      if (Object.hasOwn(value, key) && isDictionary(property) && 'const' in property
        && (typeof property.const !== 'object' || property.const === null)
        && typeof value[key] === typeof property.const && value[key] !== property.const) {
        return true
      }
    }
  }
  return false
}

const evaluated = new WeakMap<TSchema, WeakMap<Defs, TSchema>>()

// typebox merges an intersection into one schema before coercing it — its
// refs instantiated from the names in scope first, as typebox does.
function merge(schema: TSchema, defs: Defs): TSchema | undefined {
  let byDefs = evaluated.get(schema)
  if (!byDefs)
    evaluated.set(schema, byDefs = new WeakMap())
  let result = byDefs.get(defs)
  if (!result) {
    try {
      const instantiated = (OriginalType.Instantiate as (context: Defs, type: TSchema) => TSchema)(defs, schema)
      result = (OriginalType.Evaluate as (type: TSchema) => TSchema)(instantiated)
    }
    catch {
      result = schema
    }
    byDefs.set(defs, result)
  }
  return result === schema || kindOf(result) === 'Intersect' ? undefined : result
}

type Memo = Map<TSchema, WeakMap<object, unknown>>

function memoized(memo: Memo, stage: Stage): Stage {
  return (schema, value, outer) => {
    const defs = scopeOf(schema, outer)
    if (typeof value !== 'object' || value === null)
      return stage(schema, value, defs)
    let byValue = memo.get(schema)
    if (!byValue)
      memo.set(schema, byValue = new WeakMap())
    if (byValue.has(value))
      return byValue.get(value)
    const result = stage(schema, value, defs)
    byValue.set(value, result)
    return result
  }
}

// Shared by both stages: Cyclic, Ref, Intersect and the structural walk of
// arrays, tuples and records. `child` recurses into the same stage.
function navigate(schema: TSchema, value: unknown, defs: Defs, child: Stage): { done: true, value: unknown } | { done: false } {
  const node = schema as Node
  const kind = kindOf(schema)
  // A Type.Cyclic or Type.Ref, or a plain { $ref } of an adopted schema; the
  // definitions are already in scope (memoized() enters them).
  if (typeof node.$ref === 'string' && (kind === 'Cyclic' || kind === 'Ref' || kind === undefined)) {
    const target = defs[node.$ref]
    return { done: true, value: target ? child(target, value, defs) : value }
  }
  if (kind === 'Intersect') {
    const flat = merge(schema, defs)
    if (flat)
      return { done: true, value: child(flat, value, defs) }
    let current = value
    for (const member of (node.allOf as TSchema[]) ?? []) current = child(member, current, defs)
    return { done: true, value: current }
  }
  if (kind === 'Tuple') {
    if (!Array.isArray(value))
      return { done: true, value }
    const items = (node.items as TSchema[] | undefined) ?? []
    let out: unknown[] | undefined
    for (let index = 0; index < Math.min(items.length, value.length); index++) {
      const next = child(items[index]!, value[index], defs)
      if (next !== value[index])
        (out ??= value.slice())[index] = next
    }
    return { done: true, value: out ?? value }
  }
  return { done: false }
}

function convertWith(memo: Memo): Stage {
  const convert: Stage = memoized(memo, (schema, value, defs) => {
    // `undefined` is "no value", never something to convert: TypeBox's
    // Convert would turn it into '' / 0 / false and let an explicitly
    // undefined required field pass.
    if (value === undefined)
      return value
    const node = schema as Node
    const kind = kindOf(schema)
    const navigated = navigate(schema, value, defs, convert)
    if (navigated.done)
      return navigated.value
    if (kind === 'Array') {
      // A form field or query parameter sent once arrives as a lone string.
      const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : undefined
      if (!items)
        return value
      let out: unknown[] | undefined = Array.isArray(value) ? undefined : items.slice()
      items.forEach((item, index) => {
        const next = convert(node.items as TSchema, item, defs)
        if (next !== item)
          (out ??= items.slice())[index] = next
      })
      return out ?? value
    }
    if (kind === 'Object' || kind === 'Record') {
      if (!isDictionary(value))
        return value
      const properties = kind === 'Object' && isDictionary(node.properties) ? node.properties as Record<string, TSchema> : {}
      const patterns = kind === 'Record' && isDictionary(node.patternProperties)
        ? Object.entries(node.patternProperties as Record<string, TSchema>).map(([source, schema]) => [new RegExp(source), schema] as const)
        : []
      const additional = isNode(node.additionalProperties) ? node.additionalProperties as TSchema : undefined
      let out: Record<string, unknown> | undefined
      for (const key of Object.keys(value)) {
        let target: TSchema | undefined
        if (Object.hasOwn(properties, key)) {
          const property = properties[key]
          if (!isNode(property) || ('~optional' in property && value[key] === undefined))
            continue
          target = property
        }
        else {
          target = patterns.find(([pattern]) => pattern.test(key))?.[1] ?? additional
        }
        if (!target)
          continue
        const next = convert(target, value[key], defs)
        if (next !== value[key])
          define(out ??= copyOf(value), key, next)
      }
      return out ?? value
    }
    if (kind === 'Union') {
      const branches = (node.anyOf as TSchema[]) ?? []
      if (branches.some(branch => check(branch, defs, value)))
        return value
      for (const branch of branches) {
        if (ruledOut(branch, defs, value))
          continue
        const candidate = convert(branch, value, defs)
        if (check(schema, defs, candidate))
          return candidate
      }
      return value
    }
    if (typeof kind === 'string' && leafKinds.has(kind) && typeof value === 'string') {
      return typeof node.type === 'string'
        ? toType(node.type, value)
        : Value.Convert(defs as Record<string, TSchema>, schema, value)
    }
    return value
  })
  return convert
}

// Ajv's coerceTypes rules, from strings only: forms, query strings and
// environment variables deliver nothing else, and in JSON a null or a number
// where a string belongs is a client bug, not something to paper over. Only
// a string that means the same thing converts: '' and '  ' are not numbers,
// '1.5' is not an integer, 'Infinity' is not a JSON number.
function toType(type: string, value: string): unknown {
  switch (type) {
    case 'number':
    case 'integer': {
      const number = value.trim() === '' ? Number.NaN : Number(value)
      return Number.isFinite(number) && (type === 'number' || Number.isInteger(number)) ? number : value
    }
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value
    case 'null':
      return value === '' ? null : value
    default:
      return value
  }
}

function fallbackOf(schema: TSchema): unknown {
  const fallback = (schema as Node).default
  return typeof fallback === 'function' ? (fallback as () => unknown)() : structuredClone(fallback)
}

function defaultWith(memo: Memo): Stage {
  const fill: Stage = memoized(memo, (schema, input, defs) => {
    const node = schema as Node
    const kind = kindOf(schema)
    const value = input === undefined && 'default' in node ? fallbackOf(schema) : input
    // Unlike Convert, Default fills tuple positions the value doesn't reach.
    if (kind === 'Tuple') {
      if (!Array.isArray(value))
        return value
      const items = (node.items as TSchema[] | undefined) ?? []
      let out: unknown[] | undefined
      for (let index = 0; index < items.length; index++) {
        const next = fill(items[index]!, value[index], defs)
        if (next !== value[index])
          (out ??= value.slice())[index] = next
      }
      return out ?? value
    }
    const navigated = navigate(schema, value, defs, fill)
    if (navigated.done)
      return navigated.value
    if (kind === 'Array') {
      if (!Array.isArray(value))
        return value
      let out: unknown[] | undefined
      value.forEach((item, index) => {
        const next = fill(node.items as TSchema, item, defs)
        if (next !== item)
          (out ??= value.slice())[index] = next
      })
      return out ?? value
    }
    if (kind === 'Object') {
      if (typeof value !== 'object' || value === null)
        return value
      const source = value as Record<string, unknown>
      const properties = isDictionary(node.properties) ? node.properties as Record<string, TSchema> : {}
      let out: Record<string, unknown> | undefined
      for (const [key, property] of Object.entries(properties)) {
        if (!isNode(property))
          continue
        const next = fill(property, source[key], defs)
        // Undefined with nothing to assign — optional, or no default — stays absent.
        if (next === undefined && ('~optional' in property || !('default' in property)))
          continue
        if (next !== source[key] || !Object.hasOwn(source, key))
          define(out ??= copyOf(source), key, next)
      }
      const additional = node.additionalProperties
      if (isNode(additional)) {
        for (const key of Object.keys(source)) {
          if (Object.hasOwn(properties, key))
            continue
          const next = fill(additional, source[key], defs)
          if (next !== source[key])
            define(out ??= copyOf(source), key, next)
        }
      }
      return out ?? value
    }
    if (kind === 'Record') {
      if (typeof value !== 'object' || value === null)
        return value
      const source = value as Record<string, unknown>
      const [pattern, recordValue] = Object.entries((node.patternProperties ?? {}) as Record<string, TSchema>)[0] ?? []
      const key = pattern === undefined ? undefined : new RegExp(pattern)
      const additional = node.additionalProperties
      let out: Record<string, unknown> | undefined
      for (const name of Object.keys(source)) {
        const matches = key?.test(name) === true
        // typebox only descends into record values whose schema itself
        // carries a default.
        const target = matches ? (recordValue && 'default' in recordValue ? recordValue : undefined) : (isNode(additional) ? additional : undefined)
        if (!target)
          continue
        const next = fill(target, source[name], defs)
        if (next !== source[name])
          define(out ??= copyOf(source), name, next)
      }
      return out ?? value
    }
    if (kind === 'Union') {
      for (const branch of (node.anyOf as TSchema[]) ?? []) {
        if (ruledOut(branch, defs, value))
          continue
        const candidate = fill(branch, value, defs)
        if (check(branch, defs, candidate))
          return candidate
      }
      return value
    }
    return value
  })
  return fill
}

export function convert(schema: TSchema, value: unknown): unknown {
  return convertWith(new Map())(schema, value, Object.create(null))
}

export function applyDefaults(schema: TSchema, value: unknown): unknown {
  return defaultWith(new Map())(schema, value, Object.create(null))
}
