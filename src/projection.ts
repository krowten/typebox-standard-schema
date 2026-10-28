// Runtime read/write projections. Schemas compose by value (nested schema
// objects, no external $refs), so a projection is a plain recursive transform
// over a self-contained tree — no registry involved.

import type { TSchema } from 'typebox'

export type Mode = 'read' | 'write'

// Set on projection objects so targetOf() knows to validate them as-is.
// Configurable: projecting an already-projected schema re-tags the clone.
//
// A non-enumerable STRING key, not a Symbol: typebox >=1.3.13 clones schema
// nodes internally (Optional, Partial, ...) via a walk over
// Object.getOwnPropertyNames — string keys only, matching its own '~kind'/
// '~optional' markers, which is exactly why those survive such a clone and a
// Symbol never would. Type.Optional(Type.Read(User)) needs the mode to
// survive that internal clone to keep validating as a read projection.
const modeKey = '~standard-mode'

// Set on every projected object node that lost properties: the keys the
// projection cut there. Validation deletes exactly these from the data (see
// strip() in validate.ts) — the projected schema no longer declares them, so
// Check alone would wave them through as ordinary additional properties.
// Non-enumerable string key for the same reason as modeKey: it has to survive
// typebox's own internal clone, and stay out of the JSON output.
export const excludedKey = '~standard-excluded'

export function excludedOf(schema: TSchema): readonly string[] {
  return ((schema as unknown as Record<string, unknown>)[excludedKey] as string[] | undefined) ?? []
}

// Alongside the keys: the schema each cut property had, where the projection
// itself did the cutting. Validation needs it in one place — under oneOf,
// where "anything goes" for a cut key would let a branch match that the full
// schema rejects (see the twin in validate.ts).
export const cutSchemasKey = '~standard-cut-schemas'

// A Map, not a plain object: typebox walks a schema's own properties —
// hidden ones included — when it resolves $id/$ref, and a Cyclic inside a cut
// field would otherwise still shadow same-named definitions that are kept.
// `index`: the key's position among the node's properties when it was cut,
// in projection pass `round` — validation puts it back there, so typebox
// resolves anything order-sensitive (same-named Type.Cyclic definitions)
// exactly as on the full schema.
export type CutProperty = { schema: TSchema, required: boolean, index: number, round: number }

export function cutSchemasOf(schema: TSchema): ReadonlyMap<string, CutProperty> {
  return ((schema as unknown as Record<string, unknown>)[cutSchemasKey] as Map<string, CutProperty> | undefined) ?? new Map()
}

// On a projected Type.Dependent: which marks inside its `if` count as cut.
// `if` itself is never projected, so the projection modes it went through
// are recorded here instead — Type.Object({ user: Type.Read(S) }) validates as
// a write projection, yet still cuts the writeOnly fields `if` marks.
export const ifFlagsKey = '~standard-if-flags'

export function ifFlagsOf(schema: TSchema): readonly ('readOnly' | 'writeOnly')[] | undefined {
  return (schema as unknown as Record<string, unknown>)[ifFlagsKey] as ('readOnly' | 'writeOnly')[] | undefined
}

export function modeOf(schema: TSchema): Mode | undefined {
  return (schema as unknown as Record<string, unknown>)[modeKey] as Mode | undefined
}

// Which schema a projection was derived from, and how. A factory that
// rebuilds a projection (Partial/Pick, Evaluate, Interface, Index, ...) is
// re-derived from that source instead — Type.Partial(Type.Read(X)) is
// Type.Read(Type.Partial(X)) — so every node of the result is a real
// projection node with its cuts recorded fresh, not a typebox rebuild that
// lost the markers somewhere below the root. `reproject` projects a rebuilt
// source the same way: as a tagged projection (Type.Read/Type.Write and the
// reshapes of one), or as a new full schema holding projected content (a
// Type.Intersect/Type.Union of projections, and what is built from it).
export type Origin = { source: TSchema, mode: Mode, reproject: (source: TSchema) => TSchema }

const origins = new WeakMap<TSchema, Origin>()

export function recordOrigin(projection: TSchema, origin: Origin): TSchema {
  origins.set(projection, origin)
  return projection
}

export function originOf(schema: TSchema): Origin | undefined {
  return origins.get(schema)
}

// A projection's content as a new full schema: same nodes and cuts, no mode
// tag on the root — validated like any full schema (as its write projection).
export function untagged(projection: TSchema): TSchema {
  const copy = cloneWith(projection, {}) as Record<string, unknown>
  delete copy[modeKey]
  return copy as TSchema
}

export function setExcluded(schema: TSchema, keys: readonly string[]): TSchema {
  Object.defineProperty(schema, excludedKey, { value: keys, enumerable: false, configurable: true, writable: true })
  return schema
}

// Every key cut at the top level of `schema`: on the node itself, on the
// members of a union or intersection there, and on the definition a Cyclic
// root points at — all of which describe the same value.
export function topLevelCuts(schema: TSchema): string[] {
  const cut = new Set<string>()
  const seen = new Set<TSchema>()
  const collect = (node: TSchema, defs: Record<string, TSchema>): void => {
    if (typeof node !== 'object' || node === null || seen.has(node))
      return
    seen.add(node)
    const record = node as Record<string, unknown>
    if (record.$defs && typeof record.$defs === 'object')
      defs = { ...defs, ...(record.$defs as Record<string, TSchema>) }
    excludedOf(node).forEach(key => cut.add(key))
    if (typeof record.$ref === 'string' && defs[record.$ref])
      collect(defs[record.$ref]!, defs)
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const members = record[key]
      if (Array.isArray(members))
        members.forEach(member => collect(member as TSchema, defs))
    }
  }
  collect(schema, {})
  return [...cut]
}

// Records `keys` as cut on the object root of `result` too, minus what it
// declares: a reshape can drop a property the projection had already cut
// (Pick without it), and the value may still carry that key. Only an object
// root takes them — a union or intersection root keeps its cuts on the
// members (re-projected), where a matching branch that declares the key
// (a record entry, say) can still keep it.
export function carryCuts(result: TSchema, keys: readonly string[]): TSchema {
  const properties = (result as Record<string, unknown>).properties as object | undefined
  if (!properties || typeof properties !== 'object')
    return result
  const carried = keys.filter(key => !Object.hasOwn(properties, key))
  if (carried.length)
    setExcluded(result, [...new Set([...excludedOf(result), ...carried])])
  return result
}

// typebox's Partial/Required/Pick/Omit rebuild the object node from scratch,
// dropping both markers. For a projection with a recorded origin, our
// wrappers re-derive the result (see Origin); this is the fallback for one
// without — a projected node reached inside another schema — and carries the
// root's markers across. An excluded key the result declares again (never
// the case for these four) would not be cut.
export function preserveProjection(source: TSchema, result: TSchema): TSchema {
  const mode = (source as unknown as Record<string, unknown>)[modeKey] as Mode | undefined
  if (mode && !(modeKey in result))
    tag(result, mode)
  const properties = (result as unknown as Record<string, unknown>).properties as Record<string, unknown> | undefined
  const excluded = excludedOf(source).filter(key => !properties || !Object.hasOwn(properties, key))
  if (excluded.length && !(excludedKey in result))
    setExcluded(result, excluded)
  return result
}

// Clone preserving non-enumerable state: typebox 1.x keeps its markers
// ('~kind', '~optional', ...) as non-enumerable properties, which a plain
// object spread would silently drop (e.g. an Optional field would turn
// required). Copy all own descriptors, then apply the overrides.
export function cloneWith(schema: TSchema, overrides: Record<string, unknown>): TSchema {
  const clone = Object.create(
    Object.getPrototypeOf(schema),
    Object.getOwnPropertyDescriptors(schema),
  ) as TSchema
  return Object.assign(clone, overrides)
}

// ─── Structural walk ─────────────────────────────────────────────────────────
// Every position a JSON Schema node can hold child schemas in, in one place.
// Both transforms below — cutting marked properties and suffixing $ids — walk
// the same tree and differ only in what they do per node.

export type Walk = {
  // Recurse into a child node.
  next: (child: TSchema) => TSchema
  // Which object properties survive (projections drop the marked ones).
  keep?: (property: TSchema) => boolean
  // Rename $defs keys (suffixing moves definitions and their $refs together).
  rename?: (key: string) => string
  // Also visit `not` and `if`: contravariant / branch-selecting positions.
  // Safe for renaming refs and attaching interfaces (direction-agnostic);
  // NEVER safe for cutting marked fields there — that would invert what
  // `not` says, or change which `if`/`then`/`else` branch a value matches.
  // `then`/`else` merely describe the data once a branch is already picked
  // (the same covariant position as any nested schema), so they are always
  // visited below, unconditionally.
  intoBranches?: boolean
}

// Overrides rebuilding the children of `schema` — empty when nothing below
// changed, so untouched subtrees keep their identity instead of being cloned.
// `composite` reports whether the node holds children at all, which is how the
// transforms below tell a branch from a leaf without repeating this key list.
// `dropped` lists the property keys `keep` rejected.
export type Rebuilt = { overrides: Record<string, unknown>, composite: boolean, dropped: string[] }

export function rebuildChildren(schema: TSchema, walk: Walk): Rebuilt {
  const overrides: Record<string, unknown> = {}
  const dropped: string[] = []
  let composite = false
  // A boolean subschema (`true`/`false`, legal JSON Schema) holds nothing.
  if (typeof schema !== 'object' || schema === null)
    return { overrides, composite, dropped }
  const node = schema as Record<string, any>

  if (node.properties) {
    composite = true
    // Null-prototype: a property literally named '__proto__' must become an
    // own key here, not trigger Object.prototype's accessor and silently
    // repoint this dictionary's own prototype instead of holding the field.
    const properties: Record<string, TSchema> = Object.create(null)
    let changed = false
    for (const [key, property] of Object.entries<TSchema>(node.properties)) {
      if (walk.keep && !walk.keep(property)) {
        changed = true
        dropped.push(key)
        continue
      }
      const next = walk.next(property)
      changed ||= next !== property
      properties[key] = next
    }
    if (changed) {
      overrides.properties = properties
      // A dropped property has to leave `required` as well — own keys only, or
      // a field named `constructor` would look like it survived.
      if (Array.isArray(node.required))
        overrides.required = node.required.filter(key => Object.hasOwn(properties, key))
    }
  }

  // Record values live under patternProperties; nothing to filter there — a
  // mark on the value schema describes every entry, not a single field. The
  // pattern keys are regexes, never renamed.
  if (node.patternProperties) {
    composite = true
    const patterns = mapValues(node.patternProperties, walk.next)
    if (patterns)
      overrides.patternProperties = patterns
  }

  // Tuples keep their members in an items array (typebox, draft-07 — with
  // additionalItems for the rest) or prefixItems (2020-12), plain arrays a
  // single schema; additionalProperties may be a boolean, which has no
  // children. `not` is
  // deliberately absent: it is a contravariant position, so cutting fields
  // inside it would invert what the negation says ("must not have a secret"
  // would become "must not be an object").
  // unevaluatedProperties/unevaluatedItems/contains describe elements the
  // same way (a schema, or a boolean with no children).
  for (const key of ['items', 'prefixItems', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains'] as const) {
    const child = node[key]
    if (!child || typeof child !== 'object')
      continue
    composite = true
    const next = Array.isArray(child) ? mapList(child, walk.next) : mapNode(child, walk.next)
    if (next)
      overrides[key] = next
  }

  // dependentSchemas (and draft-07 `dependencies`, whose array-valued
  // entries are just required-key lists): subschemas applied to the whole
  // object once a key is present — covariant, like allOf members.
  for (const key of ['dependentSchemas', 'dependencies'] as const) {
    const entries = node[key]
    if (!entries || typeof entries !== 'object')
      continue
    composite = true
    const mapped: Record<string, unknown> = Object.create(null)
    let changed = false
    for (const [name, child] of Object.entries(entries)) {
      const next = child && typeof child === 'object' && !Array.isArray(child) ? walk.next(child as TSchema) : child
      changed ||= next !== child
      mapped[name] = next
    }
    if (changed)
      overrides[key] = mapped
  }

  for (const key of ['anyOf', 'allOf', 'oneOf'] as const) {
    if (Array.isArray(node[key])) {
      composite = true
      const next = mapList(node[key], walk.next)
      if (next)
        overrides[key] = next
    }
  }

  // `then`/`else` (Type.Dependent): the shape once a branch is already
  // selected — covariant, same as any nested schema.
  for (const key of ['then', 'else'] as const) {
    const child = node[key]
    if (!child || typeof child !== 'object')
      continue
    composite = true
    const next = mapNode(child, walk.next)
    if (next)
      overrides[key] = next
  }

  // `not`/`if`: contravariant / branch-selecting, only for walks that opt in
  // (see Walk.intoBranches above). `propertyNames` judges key strings, so
  // nothing in it is ever cut — but a rename must still reach its $refs.
  if (walk.intoBranches) {
    for (const key of ['not', 'if', 'propertyNames'] as const) {
      const child = node[key]
      if (!child || typeof child !== 'object')
        continue
      composite = true
      const next = mapNode(child, walk.next)
      if (next)
        overrides[key] = next
    }
  }

  // Cyclic roots carry their definitions inline, so recursive schemas get
  // projected (and renamed) like everything else — `definitions` being the
  // pre-2019 spelling a hand-written schema may still use.
  for (const key of ['$defs', 'definitions'] as const) {
    if (node[key] && typeof node[key] === 'object') {
      composite = true
      const defs = mapValues(node[key], walk.next, walk.rename)
      if (defs)
        overrides[key] = defs
    }
  }

  return { overrides, composite, dropped }
}

type Next = (child: TSchema) => TSchema

// The three shapes children come in. Each returns undefined when unchanged.
function mapNode(child: TSchema, next: Next): TSchema | undefined {
  const mapped = next(child)
  return mapped === child ? undefined : mapped
}

function mapList(children: TSchema[], next: Next): TSchema[] | undefined {
  const mapped = children.map(next)
  return mapped.every((child, i) => child === children[i]) ? undefined : mapped
}

function mapValues(
  children: Record<string, TSchema>,
  next: Next,
  rename?: (key: string) => string,
): Record<string, TSchema> | undefined {
  // Null-prototype for the same reason as the properties dictionary above —
  // $defs/patternProperties keys are just as attacker-controllable.
  const mapped: Record<string, TSchema> = Object.create(null)
  let changed = false
  for (const [key, child] of Object.entries(children)) {
    const renamed = rename ? rename(key) : key
    mapped[renamed] = next(child)
    changed ||= renamed !== key || mapped[renamed] !== child
  }
  return changed ? mapped : undefined
}

function withOverrides(schema: TSchema, overrides: Record<string, unknown>): TSchema {
  return Object.keys(overrides).length ? cloneWith(schema, overrides) : schema
}

// ─── The transforms ──────────────────────────────────────────────────────────

// A copy of the schema without the properties carrying the excluded flag
// ('write' drops readOnly:true, 'read' drops writeOnly:true). Every node that
// can hold children becomes a tagged projection node of its own, so reading
// ~standard off a nested node validates the projected shape instead of falling
// back to "the input shape of this schema". Leaves are shared with the source —
// their projection is themselves.
// Keys cut from an object node are recorded on its projection (excludedKey),
// merged with any recorded by an earlier projection of the same node —
// Type.Read(Type.Write(User)) cuts both.
//
// Memoized per node within one pass: a subschema shared by several parents
// (a DAG) is projected once and stays shared, instead of multiplying with
// every path that reaches it.
function project(schema: TSchema, mode: Mode, done = new Map<TSchema, TSchema>()): TSchema {
  const known = done.get(schema)
  if (known)
    return known
  const flag = mode === 'write' ? 'readOnly' : 'writeOnly'
  const { overrides, composite, dropped } = rebuildChildren(schema, {
    next: child => project(child, mode, done),
    keep: property => !(property as Record<string, unknown>)?.[flag],
  })
  let projected = schema
  if (composite) {
    unrequireCutInAllOf(schema as Record<string, any>, overrides)
    projected = tag(cloneWith(schema, overrides), mode)
    if (dropped.length) {
      setExcluded(projected, [...new Set([...excludedOf(schema), ...dropped])])
      const node = schema as Record<string, any>
      const properties = node.properties as Record<string, TSchema>
      const required = Array.isArray(node.required) ? node.required as string[] : []
      const order = Object.keys(properties)
      const earlier = cutSchemasOf(schema)
      const round = Math.max(0, ...[...earlier.values()].map(entry => entry.round + 1))
      const schemas = new Map([...earlier, ...dropped.map(key => [key, { schema: properties[key]!, required: required.includes(key), index: order.indexOf(key), round }] as const)])
      Object.defineProperty(projected, cutSchemasKey, { value: schemas, enumerable: false, configurable: true, writable: true })
    }
    const condition = (schema as Record<string, any>).if
    if (condition && typeof condition === 'object') {
      const flags = [...new Set([...(ifFlagsOf(schema) ?? []), flag])]
      Object.defineProperty(projected, ifFlagsKey, { value: flags, enumerable: false, configurable: true, writable: true })
    }
  }
  if (typeof schema === 'object' && schema !== null)
    done.set(schema, projected)
  return projected
}

// A key one allOf member cut is gone from the data, so another member may not
// go on requiring it — Type.Read(Type.Intersect([{ note: Writeonly }, { note
// (required) }])) would otherwise describe a shape nothing can satisfy. The
// cut key leaves the `required` of every member.
function unrequireCutInAllOf(node: Record<string, any>, overrides: Record<string, unknown>): void {
  const members = (overrides.allOf ?? node.allOf) as TSchema[] | undefined
  if (!Array.isArray(members))
    return
  const cut = new Set(members.flatMap(member => typeof member === 'object' && member !== null ? topLevelCuts(member) : []))
  if (!cut.size)
    return
  const next = members.map(member => unrequire(member, cut))
  if (next.some((member, i) => member !== members[i]))
    overrides.allOf = next
}

// Drops `cut` from `required` (and from property defaults) on the node and,
// since they describe the same value, through its own union and intersection
// members.
//
// A Cyclic member ({ $defs, $ref }) is unrequired through a sibling alias of
// the definition it points at: the definition itself stays as it is, since
// its own recursive references still mean the original shape.
function unrequire(schema: TSchema, cut: ReadonlySet<string>): TSchema {
  if (typeof schema !== 'object' || schema === null)
    return schema
  const node = schema as Record<string, any>
  const overrides: Record<string, unknown> = {}
  const defs = node.$defs as Record<string, TSchema> | undefined
  if (defs && typeof defs === 'object' && typeof node.$ref === 'string' && Object.hasOwn(defs, node.$ref)) {
    const target = defs[node.$ref]!
    const alias = unrequire(target, cut)
    if (alias !== target) {
      const name = `${node.$ref}_unrequired`
      // typebox resolves a Cyclic's names through each definition's $id.
      const copy = cloneWith(alias, { $id: name })
      overrides.$defs = Object.assign(Object.create(null), defs, { [name]: copy })
      overrides.$ref = name
    }
  }
  if (Array.isArray(node.required) && node.required.some((key: string) => cut.has(key)))
    overrides.required = node.required.filter((key: string) => !cut.has(key))
  // Nor may it default the key back in after it was removed.
  const properties = node.properties as Record<string, TSchema> | undefined
  if (properties && typeof properties === 'object' && [...cut].some(key => Object.hasOwn(properties, key) && withDefault(properties[key]!))) {
    const next: Record<string, TSchema> = Object.create(null)
    for (const [key, property] of Object.entries(properties))
      next[key] = cut.has(key) && withDefault(property) ? withoutDefault(property) : property
    overrides.properties = next
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!Array.isArray(node[key]))
      continue
    const members = (node[key] as TSchema[]).map(member => unrequire(member, cut))
    if (members.some((member, i) => member !== node[key][i]))
      overrides[key] = members
  }
  return Object.keys(overrides).length ? cloneWith(schema, overrides) : schema
}

function withDefault(schema: TSchema): boolean {
  return typeof schema === 'object' && schema !== null && 'default' in schema
}

function withoutDefault(schema: TSchema): TSchema {
  const copy = cloneWith(schema, {}) as Record<string, unknown>
  delete copy.default
  return copy as TSchema
}

// Appends `suffix` to every $id in the tree. Cyclic subtrees are renamed
// consistently — $defs keys, the $id each definition carries, and every $ref
// pointing at a definition move together, so local resolution stays intact.
export function suffixIds(schema: TSchema, suffix: string, defKeys: ReadonlySet<string> = new Set()): TSchema {
  const node = schema as Record<string, any>
  const names = [...Object.keys(node.$defs ?? {}), ...Object.keys(node.definitions ?? {})]
  const local = names.length ? new Set([...defKeys, ...names]) : defKeys

  const { overrides } = rebuildChildren(schema, {
    next: child => suffixIds(child, suffix, local),
    rename: key => key + suffix,
    // Renaming a $ref is direction-agnostic — reach it under `not`/`if` too,
    // or a local ref there keeps pointing at the definition's old name.
    intoBranches: true,
  })
  if (typeof node.$id === 'string')
    overrides.$id = node.$id + suffix
  // The schemas of cut fields, kept aside for validation, name the same
  // definitions — they follow the rename too.
  const cut = cutSchemasOf(schema)
  if (cut.size)
    overrides[cutSchemasKey] = new Map([...cut].map(([key, entry]) => [key, { ...entry, schema: suffixIds(entry.schema, suffix, local) }]))
  if (typeof node.$ref === 'string') {
    // A plain name (Type.Cyclic) or a JSON pointer into $defs/definitions
    // (hand-written): either way it follows the definition it names.
    const pointer = /^(#\/(?:\$defs|definitions)\/)(.+)$/.exec(node.$ref)
    if (pointer && local.has(pointer[2]!))
      overrides.$ref = pointer[1]! + pointer[2]! + suffix
    else if (local.has(node.$ref))
      overrides.$ref = node.$ref + suffix
  }

  return withOverrides(schema, overrides)
}

// ─── Projection identity ─────────────────────────────────────────────────────

// Memoized projections: repeated calls return the same object, so identity
// checks and WeakMap keys (the compiled-validator cache) work.
const cache = new WeakMap<TSchema, Partial<Record<Mode, TSchema>>>()

export function projectionOf(schema: TSchema, mode: Mode): TSchema {
  let entry = cache.get(schema)
  if (!entry)
    cache.set(schema, (entry = {}))
  // The root is always an object of its own: project() hands leaves back
  // untouched, and tagging one of those would stamp the mode onto the user's
  // schema (and make Type.Read(S) === Type.Write(S) === S).
  return (entry[mode] ??= tag(rootOf(project(schema, mode), schema), mode))
}

function rootOf(projected: TSchema, source: TSchema): TSchema {
  return projected === source ? cloneWith(source, {}) : projected
}

export function tag(projection: TSchema, mode: Mode): TSchema {
  Object.defineProperty(projection, modeKey, { value: mode, enumerable: false, configurable: true, writable: true })
  return projection
}

// The validation target for a schema: a projection obtained from
// Type.Read/Type.Write validates as itself; a full schema validates against
// its write projection (inputs are the common case).
export function targetOf(schema: TSchema): TSchema {
  const mode = (schema as unknown as Record<string, unknown>)[modeKey] as Mode | undefined
  return mode ? schema : projectionOf(schema, 'write')
}
