// The curated `Type` builder: typebox's factories copied onto a plain object
// (see the note further down on why not a Proxy), each wrapped to inject
// ~standard, plus our own Read/Write/Readonly/Writeonly/Partial. Schemas
// compose by value (nested objects) — for recursive types use Type.Cyclic,
// whose string refs resolve against its own inline $defs.

import type { TKeysToIndexer, TObject, TOmit, TPartial, TPick, TRequired, TSchema, TSchemaOptions } from 'typebox'
import type { WithStandard } from './standard'
import type { TRead, TReadonly, TReshaped, TWrite, TWriteonly } from './types'
import OriginalType from 'typebox'
import { carryCuts, cloneWith, modeOf, originOf, preserveProjection, projectionOf, rebuildChildren, recordOrigin, suffixIds, tag, topLevelCuts, untagged } from './projection'
import { attachStandard } from './validate'

// Re-attaches ~standard to every schema-shaped node reachable from `schema`,
// not just the root. typebox's own internal clone (Optional, Partial, Pick,
// Omit, Required, Evaluate, ...) rebuilds nodes as plain objects that never
// pass back through our wrapped factories, so a nested node that already had
// ~standard loses it there — attachStandard() alone only ever sees the
// outermost result. intoBranches reaches Type.Dependent's `not`/`if` too;
// attachStandard is idempotent, so re-visiting a shared subschema is cheap.
function attachStandardDeep(schema: TSchema): TSchema {
  attachStandard(schema)
  rebuildChildren(schema, {
    next: (child) => {
      attachStandardDeep(child)
      return child
    },
    intoBranches: true,
  })
  return schema
}

// Field marks. Clone (don't mutate — the inner schema may be a shared const
// like Email) and set the standard JSON Schema keyword; the return type carries
// the brand for TRead/TWrite. A plain `{ readOnly: true }` option would work at
// runtime but is erased at the type level — the brand is what lets static
// projections match the runtime ones. Descriptor-based clone keeps typebox's
// non-enumerable markers ('~kind', '~optional') intact.
function Readonly<T extends TSchema>(schema: T): TReadonly<T> {
  return attachStandard(cloneWith(schema, { readOnly: true })) as TReadonly<T>
}
function Writeonly<T extends TSchema>(schema: T): TWriteonly<T> {
  return attachStandard(cloneWith(schema, { writeOnly: true })) as TWriteonly<T>
}

// Projections. Memoized per schema — repeated calls return the same object.
// With options the projection is cloned as a standalone schema: `suffix` is
// appended to every $id in the tree (naming the derived shapes for docs —
// '/user' → '/user/input', 'User' → 'UserInput'), the remaining options
// override the root ($id there wins over the suffixed one).
export type ProjectionOptions = TSchemaOptions & { suffix?: string }

function Read<T extends TSchema>(schema: T, options?: ProjectionOptions): TRead<T> {
  return projection(schema, 'read', options) as TRead<T>
}
function Write<T extends TSchema>(schema: T, options?: ProjectionOptions): TWrite<T> {
  return projection(schema, 'write', options) as TWrite<T>
}
function projection(schema: TSchema, mode: 'read' | 'write', options?: ProjectionOptions): TSchema {
  const origin = { source: schema, mode, reproject: (source: TSchema) => projection(source, mode, options) }
  const projected = projectionOf(schema, mode)
  if (!options)
    return recordOrigin(attachStandardDeep(projected), origin)
  const { suffix, ...overrides } = options
  const suffixed = suffix ? suffixIds(projected, suffix) : projected
  return recordOrigin(attachStandardDeep(tag(cloneWith(suffixed, overrides), mode)), origin)
}

// typebox's Partial keeps `default` annotations on the now-optional fields,
// and the validation pipeline applies defaults — an absent field in a partial
// update would be silently reset to its default. Strip top-level property
// defaults (shallow, matching Partial's own shallow semantics; a nested object,
// when present, still validates and defaults against its full schema).
//
// Applied to each of a Partial'd object's own direct properties: strips a
// leaf `default`, transparently through anyOf/allOf — `status:
// Type.Union([Type.String({ default: 'draft' }), Type.Number()])` hides its
// default inside a branch, not on the property node itself, and typebox's
// Default still materializes it there for an absent top-level field. Stops
// at any nested object's own .properties instead of recursing into it — a
// nested object passed as a property value still validates and defaults
// against its own full schema, per Type.Partial's shallow contract.
function stripPropertyDefault(property: TSchema): TSchema {
  const node = property as Record<string, any>
  const overrides: Record<string, unknown> = {}

  // A default hidden inside a branch (Type.Union([Type.String({ default }),
  // ...])) and a default on the union itself (Type.Union([...], { default }))
  // are independent — check both, not one instead of the other.
  for (const key of ['anyOf', 'allOf'] as const) {
    if (Array.isArray(node[key])) {
      const branches = (node[key] as TSchema[]).map(stripPropertyDefault)
      if (branches.some((branch, i) => branch !== (node[key] as TSchema[])[i]))
        overrides[key] = branches
    }
  }

  if ('default' in node) {
    const clone = cloneWith(property, overrides) as Record<string, unknown>
    delete clone.default
    return clone as TSchema
  }

  return Object.keys(overrides).length ? cloneWith(property, overrides) : property
}

// The public signature accepts anything typebox's own Partial does, which
// includes Type.Union/Type.Intersect — Partial(Union([A, B])) comes back as
// Union([Partial(A), Partial(B)]), each branch partialled independently, not
// a single object. stripDefaults walks into anyOf/allOf to reach every such
// branch's own top-level properties.
function stripDefaults(schema: TSchema): TSchema {
  const node = schema as Record<string, any>

  if (node.properties) {
    const properties: Record<string, TSchema> = Object.create(null)
    let changed = false
    for (const [key, property] of Object.entries<TSchema>(node.properties)) {
      const stripped = stripPropertyDefault(property)
      changed ||= stripped !== property
      properties[key] = stripped
    }
    return changed ? cloneWith(schema, { properties }) : schema
  }

  for (const key of ['anyOf', 'allOf'] as const) {
    if (Array.isArray(node[key])) {
      const branches = (node[key] as TSchema[]).map(stripDefaults)
      if (branches.some((branch, i) => branch !== (node[key] as TSchema[])[i]))
        return cloneWith(schema, { [key]: branches })
    }
  }

  return schema
}

function partialOf(schema: TSchema, options?: TSchemaOptions): TSchema {
  return attachStandardDeep(stripDefaults(OriginalType.Partial(schema as unknown as TObject, options)))
}

// Partial/Required/Pick/Omit reshape a projection without changing what it
// is. A projection from Type.Read/Type.Write is re-derived from its source —
// the reshape applied there, then projected again (see Origin in
// projection.ts) — so unions, intersections and Cyclic definitions come out
// fully projected, not as typebox rebuilds that dropped the markers below the
// root. Anything else only gets its root's markers carried across.
//
// Partial and Required distribute over a union or intersection anyway, so
// one with no common origin — projections of different modes, or mixed with
// plain schemas — is reshaped member by member, each projection through its
// own origin, instead of letting typebox rebuild the members unmarked.
function reshaping(factory: (schema: TSchema, ...rest: unknown[]) => TSchema, distributive = false) {
  const reshape = (schema: TSchema, ...rest: unknown[]): TSchema => {
    const origin = originOf(schema)
    if (origin)
      return carryCuts(origin.reproject(factory(origin.source, ...rest)), topLevelCuts(schema))
    const node = schema as Record<string, unknown>
    for (const key of ['anyOf', 'allOf'] as const) {
      const members = node[key]
      if (distributive && Array.isArray(members) && members.some(isProjection))
        return attachStandardDeep(cloneWith(schema, { [key]: members.map(member => isSchema(member) ? reshape(member, ...rest) : member) }))
    }
    return attachStandardDeep(carryCuts(preserveProjection(schema, factory(schema, ...rest)), topLevelCuts(schema)))
  }
  return reshape
}

const Partial = reshaping(partialOf as (schema: TSchema, ...rest: unknown[]) => TSchema, true)

const custom: Record<string, unknown> = {
  Read,
  Write,
  Readonly,
  Writeonly,
  Partial,
  Required: reshaping(wrapFactory(OriginalType.Required as (...a: unknown[]) => unknown) as (schema: TSchema, ...rest: unknown[]) => TSchema, true),
  Pick: reshaping(wrapFactory(OriginalType.Pick as (...a: unknown[]) => unknown) as (schema: TSchema, ...rest: unknown[]) => TSchema),
  Omit: reshaping(wrapFactory(OriginalType.Omit as (...a: unknown[]) => unknown) as (schema: TSchema, ...rest: unknown[]) => TSchema),
  Cyclic: wrapFactory(function (this: unknown, ...args: unknown[]) {
    // Without a root name typebox builds { $defs } with no $ref: a schema that
    // accepts anything, so the marks in its definitions would cut nothing.
    const [defs, ref] = args
    if (typeof ref !== 'string' || typeof defs !== 'object' || defs === null || !Object.hasOwn(defs, ref))
      throw new TypeError(`Type.Cyclic needs the name of its root definition as the second argument (got ${JSON.stringify(ref)})`)
    return (OriginalType.Cyclic as (...a: unknown[]) => unknown).apply(this, args)
  }, 'Cyclic'),
}

// `typeof OriginalType`'s methods keep their own generic signatures as-is —
// their return types (TObject<P>, TArray<T>, ...) already carry '~standard'
// via the module augmentation in augment.ts, generics fully preserved.
// Our Readonly REPLACES the built-in TS-modifier Readonly (which only sets the
// '~readonly' marker and never reaches the JSON output). Type.Ref passes
// through natively: its only supported use is inside Type.Cyclic definitions,
// where string refs resolve locally.
// Partial/Required/Pick/Omit keep typebox's own signatures, wrapped in
// TReshaped so a projection passed in stays a projection statically too.
type CustomType = Omit<typeof OriginalType, 'Readonly' | 'Partial' | 'Required' | 'Pick' | 'Omit'> & {
  Read: <T extends TSchema>(schema: T, options?: ProjectionOptions) => TRead<T>
  Write: <T extends TSchema>(schema: T, options?: ProjectionOptions) => TWrite<T>
  Readonly: <T extends TSchema>(schema: T) => TReadonly<T>
  Writeonly: <T extends TSchema>(schema: T) => TWriteonly<T>
  Partial: <T extends TSchema>(type: T, options?: TSchemaOptions) => TReshaped<T, TPartial<T>>
  Required: <T extends TSchema>(type: T, options?: TSchemaOptions) => TReshaped<T, TRequired<T>>
  Pick: {
    <T extends TSchema, I extends PropertyKey[]>(type: T, indexer: readonly [...I], options?: TSchemaOptions): TReshaped<T, TPick<T, TKeysToIndexer<I>>>
    <T extends TSchema, I extends TSchema>(type: T, indexer: I, options?: TSchemaOptions): TReshaped<T, TPick<T, I>>
  }
  Omit: {
    <T extends TSchema, I extends PropertyKey[]>(type: T, indexer: readonly [...I], options?: TSchemaOptions): TReshaped<T, TOmit<T, TKeysToIndexer<I>>>
    <T extends TSchema, I extends TSchema>(type: T, indexer: I, options?: TSchemaOptions): TReshaped<T, TOmit<T, I>>
  }
}

// Wraps every factory to inject ~standard, so each schema is Standard Schema v1
// compliant out of the box (validation itself stays lazy — nothing compiles
// until called). Not every factory result is a finished schema, though:
// Type.Codec(schema) returns a DecodeBuilder — a bare object carrying only a
// `Decode` method, no '~kind' — and only becomes a real TCodec schema once
// `.Decode(fn).Encode(fn)` both run. typebox's own IsSchemaObject check
// (own '~kind' or '~unsafe') is the same test we use here: attach only when
// the result already is a schema, and for a builder, shadow its own
// chainable methods (own-property, not the shared class prototype — other
// unrelated codec chains are untouched) so whatever schema comes out the far
// end of the chain still gets attachStandardDeep, however many calls deep.
function process(result: unknown, args: readonly unknown[] = [], rebuild?: (args: unknown[]) => unknown, name = ''): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return result
  if ('~kind' in result || '~unsafe' in result)
    return attachStandardDeep(rederive(result as TSchema, args, rebuild, name))
  return shadowBuilderMethods(result)
}

function isSchema(value: unknown): value is TSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && ('~kind' in value || '~unsafe' in value)
}

function isProjection(value: unknown): value is TSchema {
  return isSchema(value) && (originOf(value) !== undefined || modeOf(value) !== undefined)
}

// Whether `result` holds every one of `schemas` as-is, as a direct child —
// Union, Intersect, Array and the like keep their arguments by reference.
function keepsAll(result: TSchema, schemas: readonly TSchema[]): boolean {
  const node = result as Record<string, unknown>
  const kept = new Set<unknown>([result])
  for (const key of ['anyOf', 'allOf', 'oneOf', 'items', 'prefixItems', 'additionalProperties'] as const) {
    const children = node[key]
    if (Array.isArray(children))
      children.forEach(child => kept.add(child))
    else if (children)
      kept.add(children)
  }
  for (const key of ['properties', 'patternProperties'] as const) {
    if (node[key] && typeof node[key] === 'object')
      Object.values(node[key] as object).forEach(child => kept.add(child))
  }
  return schemas.every(schema => kept.has(schema))
}

// Factories whose rebuild commutes with projecting: merging or selecting
// parts of projections is the projection of merging or selecting the same
// parts of the sources. Not so for KeyOf, Mapped, Extends/Conditional,
// Exclude/Extract — they enumerate or compare types, and the source has keys
// the projection doesn't — so those are never replayed.
const replayable = new Set(['Evaluate', 'Interface', 'Index'])

// A factory called with projections among its arguments. Three outcomes:
//
// - typebox cloned the projection (Codec, Immutable, Refine, Unsafe, ...):
//   its markers, mode tag included, came along — nothing to do.
// - the result keeps the projections as-is (Union, Intersect, Array, ...):
//   it is a new full schema around projected content. It gets an Origin, so
//   whatever is later rebuilt out of it can be re-derived too.
// - typebox rebuilt nodes out of them (Evaluate, Interface, Index), dropping
//   the keys each had cut. The call is replayed on the sources and the result
//   projected afresh — every cut recorded again, at any depth — as a new
//   full schema, like the input.
//
// Projections of different modes, or projected nodes with no recorded
// source (reached inside another schema), can't be replayed; then only the
// keys cut at their top level are carried onto a merged root.
function rederive(result: TSchema, args: readonly unknown[], rebuild?: (args: unknown[]) => unknown, name = ''): TSchema {
  const schemas = args.flatMap(arg => Array.isArray(arg) ? arg.filter(isSchema) : isSchema(arg) ? [arg] : [])
  const projections = schemas.filter(isProjection)
  // Plain schemas holding projections at their top level (an intersection
  // of a projection and a plain object) lose those cuts in a rebuild too.
  const cuts = schemas.flatMap(topLevelCuts)
  if ((!projections.length && !cuts.length) || modeOf(result) !== undefined)
    return result
  const kept = keepsAll(result, schemas.filter(schema => isProjection(schema) || topLevelCuts(schema).length))
  if (!rebuild) {
    // Not replayable, yet the result may just be one of the projections
    // rebuilt (Conditional/Extract picking a branch): the same JSON, minus
    // the markers. Then the projection itself is the answer — unless a plain
    // schema among the arguments has that same JSON and may be the pick.
    const json = JSON.stringify(result)
    const plainTwin = schemas.some(schema => !isProjection(schema) && JSON.stringify(schema) === json)
    return plainTwin ? result : projections.find(projection => JSON.stringify(projection) === json) ?? result
  }
  // Replaying swaps each projection for its source and projects the result
  // as a whole — which is only the same thing when there is nothing else in
  // it: no plain schema argument (its own marks would be projected too), no
  // schemas passed in a properties object (Interface), one mode throughout.
  const origins = projections.map(originOf)
  const modes = new Set(origins.map(origin => origin?.mode))
  const plainContent = schemas.length !== projections.length
    || args.some(arg => isDictionary(arg) && !isSchema(arg) && Object.values(arg).some(isSchema))
  // Index of a key the projection cut: typebox already answers Never on the
  // projection; the source would still have the key.
  const cutIndex = name === 'Index' && Array.isArray(args[1])
    && args[1].some(key => projections.some(projection => topLevelCuts(projection).includes(String(key))))
  if (modes.size !== 1 || origins.includes(undefined) || plainContent || cutIndex)
    return kept || cutIndex ? result : carryCuts(result, cuts)
  const mode = origins[0]!.mode
  const sourceOf = (value: unknown): unknown => (isSchema(value) && originOf(value)?.source) || value
  const source = rebuild(args.map(arg => Array.isArray(arg) ? arg.map(sourceOf) : sourceOf(arg))) as TSchema
  // The projection itself rebuilt (Evaluate(Type.Read(X))) stays that
  // projection; anything built around projections is a new full schema.
  const sole = schemas.length === 1 && modeOf(schemas[0]!) !== undefined
  const reproject = (rebuilt: TSchema): TSchema => sole ? origins[0]!.reproject(rebuilt) : untagged(projection(rebuilt, mode))
  const derived = kept ? result : reproject(source)
  return recordOrigin(derived, { source, mode, reproject })
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shadowBuilderMethods(builder: object): object {
  const prototype = Object.getPrototypeOf(builder) as object | null
  if (!prototype)
    return builder
  for (const key of Reflect.ownKeys(prototype)) {
    if (key === 'constructor')
      continue
    const original = (builder as Record<PropertyKey, unknown>)[key]
    if (typeof original !== 'function')
      continue
    Object.defineProperty(builder, key, {
      value: (...args: unknown[]) => process((original as (...a: unknown[]) => unknown).apply(builder, args)),
      configurable: true,
      writable: true,
    })
  }
  return builder
}

// typebox's Evaluate merges a property two intersection members both declare
// into a fresh schema — dropping the readOnly/writeOnly either member put on
// it, so a merged `credentials: Writeonly(...)` would be neither cut by a read
// projection nor by any validation. Each merged property gets back every mark
// its members carried, at any depth.
function evaluate(schema: TSchema, ...rest: unknown[]): TSchema {
  return remark((OriginalType.Evaluate as (...args: unknown[]) => TSchema)(schema, ...rest), membersOf(schema))
}

function membersOf(schema: unknown): TSchema[] {
  const node = schema as Record<string, unknown>
  if (!node || typeof node !== 'object')
    return []
  return Array.isArray(node.allOf) ? node.allOf.flatMap(membersOf) : [schema as TSchema]
}

function remark(merged: TSchema, members: readonly TSchema[]): TSchema {
  const properties = (merged as Record<string, unknown>).properties as Record<string, TSchema> | undefined
  if (!properties || typeof properties !== 'object' || members.length < 2)
    return merged
  let changed = false
  const next: Record<string, TSchema> = Object.create(null)
  for (const [key, property] of Object.entries(properties)) {
    const sources = members
      .map(member => ((member as Record<string, unknown>).properties as Record<string, TSchema> | undefined)?.[key])
      .filter((source): source is TSchema => typeof source === 'object' && source !== null)
    const marks: Record<string, unknown> = {}
    for (const flag of ['readOnly', 'writeOnly'] as const) {
      if (sources.some(source => (source as Record<string, unknown>)[flag]) && !(property as Record<string, unknown>)[flag])
        marks[flag] = true
    }
    let rebuilt = remark(property, sources.flatMap(membersOf))
    if (Object.keys(marks).length)
      rebuilt = cloneWith(rebuilt, marks)
    changed ||= rebuilt !== property
    next[key] = rebuilt
  }
  return changed ? cloneWith(merged, { properties: next }) : merged
}

// `name` decides whether a rebuild of projections may be replayed on their
// sources (see `replayable`); containers are recognized by shape instead.
function wrapFactory(factory: (...args: unknown[]) => unknown, name = '') {
  return function (this: unknown, ...args: unknown[]) {
    const result = factory.apply(this, args)
    const rebuild = replayable.has(name) || (isSchema(result) && keepsAll(result, args.flatMap(arg => Array.isArray(arg) ? arg.filter(isProjection) : isProjection(arg) ? [arg] : [])))
      ? (replayed: unknown[]) => factory.apply(this, replayed)
      : undefined
    return process(result, args, rebuild, name)
  }
}

// A plain object, NOT a Proxy over typebox's default export. That export is a
// module namespace; a Rollup production bundle freezes it, so its factory
// properties become non-writable + non-configurable. A Proxy get trap that
// returned wrapped factories would then violate the Proxy invariant and throw
// at runtime ("'get' on proxy: property 'String' is read-only and
// non-configurable") — only in the bundled build, not in dev/bun. Copying the
// factories onto a plain object decouples us from the source descriptors: our
// own properties are configurable, so nothing can trip the invariant. Snapshot
// is safe — the namespace is fully populated and stable at import time.
const built: Record<string | symbol, unknown> = { ...custom }
for (const key of Reflect.ownKeys(OriginalType)) {
  if (key in built)
    continue
  const value = Reflect.get(OriginalType, key)
  const factory = key === 'Evaluate' ? evaluate : value
  built[key] = typeof factory === 'function' ? wrapFactory(factory as (...a: unknown[]) => unknown, String(key)) : factory
}

export const Type = built as unknown as CustomType

// typebox's Check compiles plain JSON Schema fine (it's ajv-style, structural),
// but Convert/Default dispatch on the internal '~kind' marker our own
// factories always carry — a plain JSON Schema object (drizzle-typebox, a
// hand-written object literal, @sinclair/typebox 0.34 output) has none, so
// those two silently no-op on it: Check alone still validates it, but the
// promised coercion/defaulting never runs. Stamping '~kind'
// by structural inference (the same mapping typebox's own type/*.mjs modules
// use — properties → 'Object', array items → 'Tuple', etc.) brings it in
// without needing the source library at all.
//
// A kind is a promise about shape, not just a label: typebox's own walkers
// read `properties` off every 'Object', `items` off every 'Array'/'Tuple',
// unconditionally — Compile throws outright on `{ type: 'object' }` stamped
// 'Object' with no `properties`. So a node is stamped only when it carries
// exactly what its kind implies, and left unstamped otherwise (a bare
// `{ type: 'object' }` or `{}`) — Check still covers it, only the extra
// pipeline stages skip that node.
//
// Declared properties outrank a sibling anyOf/allOf: stamped 'Union' or
// 'Intersect', such a node would have Convert/Default look only at its
// branches and never at its own properties. A 2020-12 tuple (prefixItems)
// has no typebox kind at all — typebox's Tuple keeps members in `items`.
function inferKind(node: Record<string, unknown>): string | undefined {
  const isDictionary = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)
  if (isDictionary(node.properties))
    return 'Object'
  if (Array.isArray(node.anyOf))
    return 'Union'
  if (Array.isArray(node.allOf))
    return 'Intersect'
  if (isDictionary(node.patternProperties))
    return 'Record'
  // A dictionary spelled with additionalProperties alone: an 'Object' with no
  // declared keys — normalizeAdopted supplies the empty `properties` it needs.
  if (node.type === 'object' && isDictionary(node.additionalProperties))
    return 'Object'
  if (node.type === 'array' && !('prefixItems' in node))
    return Array.isArray(node.items) ? 'Tuple' : isDictionary(node.items) ? 'Array' : undefined
  if (node.type === 'string')
    return 'String'
  if (node.type === 'integer')
    return 'Integer'
  if (node.type === 'number')
    return 'Number'
  if (node.type === 'boolean')
    return 'Boolean'
  if (node.type === 'null')
    return 'Null'
  return undefined
}

// Walks every child position a projection can reach (the shared
// rebuildChildren list, `not`/`if` included), so a nested object under
// additionalProperties, $defs or a then/else branch gets its kind as well.
// A node that already has a kind (built by typebox, or adopted before) keeps
// it, but the walk goes on below it: a plain JSON Schema nested inside a
// Type.Object is exactly what adopt(outer) is there to bring in.
function normalizeAdopted(schema: TSchema, seen = new Set<TSchema>()): TSchema {
  if (typeof schema !== 'object' || schema === null || seen.has(schema))
    return schema
  seen.add(schema)
  const node = schema as Record<string, unknown>

  if (!('~kind' in node) && !('~unsafe' in node)) {
    const kind = inferKind(node)
    if (kind)
      Object.defineProperty(node, '~kind', { value: kind, enumerable: false, configurable: true, writable: true })
    // Non-enumerable, like the marker itself: `properties: {}` constrains
    // nothing, and JSON output stays exactly what the caller wrote.
    if (kind === 'Object' && !('properties' in node))
      Object.defineProperty(node, 'properties', { value: {}, enumerable: false, configurable: true, writable: true })
  }

  rebuildChildren(schema, {
    next: (child) => {
      normalizeAdopted(child, seen)
      return child
    },
    intoBranches: true,
  })
  return schema
}

// Brings an externally-created TypeBox schema (e.g. from drizzle-typebox, which
// is still built against @sinclair/typebox 0.34 — its output is plain JSON
// Schema, which the 1.x engine consumes fine) into our system by injecting
// ~standard. Use this for any schema NOT built via our `Type`.
export function adopt<T extends TSchema>(schema: T): WithStandard<T> {
  return attachStandard(normalizeAdopted(schema)) as WithStandard<T>
}
