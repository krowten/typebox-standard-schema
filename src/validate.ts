// Validation pipeline and the runtime side of Standard Schema v1: validate()
// for direct use, attachStandard() for making any schema spec-compliant.

import type { Static, TSchema } from 'typebox'
import type { Validator } from 'typebox/compile'
import type { StandardProps } from './standard'
import type { TValidated } from './types'
import OriginalType from 'typebox'
import { Compile } from 'typebox/compile'
import { applyDefaults, convert, liftNested } from './coerce'
import { collectErrors } from './errors'
import { compiledCache } from './format'
import { emitJsonSchema } from './json-schema'
import { cloneWith, cutSchemasOf, excludedOf, ifFlagsOf, modeOf, rebuildChildren, targetOf } from './projection'

// Extended issue: message is the English default from typebox; keyword + params
// mirror the ajv-style error units of typebox 1.x (e.g. keyword 'minLength',
// params { minLength: 8 }) — enough for i18n mapping downstream.
export type ValidationIssue = {
  message: string
  keyword: string
  params: Record<string, unknown>
  path: (string | number)[]
}

export type ValidationResult<T>
  = { success: true, data: T } | { success: false, errors: ValidationIssue[] }

type CompiledError = {
  keyword: string
  instancePath: string
  params: Record<string, unknown>
  message: string
}

// typebox reports instancePath as a JSON Pointer with RFC 6901 escaping (since
// 1.3.34): a property literally named 'a/b' arrives as '/a~1b', one segment.
// Only the validated value can tell an array index from an object key named
// '42': a segment under an array is a number, anywhere else it stays a string.
function resolvePath(pointer: string, root: unknown): (string | number)[] {
  if (pointer === '')
    return []
  const path: (string | number)[] = []
  let value = root
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(value) && /^\d+$/.test(segment)) {
      path.push(Number(segment))
      value = value[Number(segment)]
      continue
    }
    path.push(segment)
    value = value !== null && typeof value === 'object' && Object.hasOwn(value, segment)
      ? (value as Record<string, unknown>)[segment]
      : undefined
  }
  return path
}

// typebox 1.x reports a single `required` error per object listing all missing
// properties — fan it out into one issue per property so form consumers can
// attach each message to its field.
function toIssues(errors: CompiledError[], root: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const e of errors) {
    const base = resolvePath(e.instancePath, root)
    if (e.keyword === 'required' && Array.isArray(e.params.requiredProperties)) {
      for (const prop of e.params.requiredProperties as string[]) {
        issues.push({
          message: `must have required property ${prop}`,
          keyword: 'required',
          params: { missingProperty: prop },
          path: [...base, prop],
        })
      }
      continue
    }
    issues.push({ message: e.message, keyword: e.keyword, params: e.params, path: base })
  }
  return issues
}

// Compiled (JIT) validators, cached per validation target. Schemas are
// self-contained trees (composition by value, Cyclic for recursion), so each
// target compiles standalone — no context; the cache only starts over when
// the format registry changes (see format.ts).
const validators = compiledCache<TSchema, Validator>()

function compiledFor(target: TSchema): Validator {
  let validator = validators().get(target)
  if (!validator) {
    validator = Compile(target)
    validators().set(target, validator)
  }
  return validator
}

// What the pipeline needs to know about a target's tree, gathered in one walk
// and memoized alongside the compiled validator:
//
// - `recursive` — anything that can make the schema recurse: a Type.Cyclic
//   ($defs, or `definitions`) or any $ref, anywhere in the tree —
//   Type.Object({ tree: Tree }) recurses exactly as deep as Tree does.
// - `cuts` — a projection cut keys somewhere below, or an `if` might carry
//   marked fields (see strip()). Without either, there is nothing to strip.
// - `defaults` — some node carries a `default`; without one, Default is
//   skipped.
// - `branches` — some node is a union (anyOf/oneOf). With `recursive`, error
//   collection goes through errors.ts instead of typebox's, which explodes
//   on deep invalid data there.
type Traits = { recursive: boolean, cuts: boolean, defaults: boolean, branches: boolean }

const traits = new WeakMap<TSchema, Traits>()

function traitsOf(target: TSchema): Traits {
  let found = traits.get(target)
  if (!found) {
    found = { recursive: false, cuts: false, defaults: false, branches: false }
    scan(target, found, new Set())
    traits.set(target, found)
  }
  return found
}

function isNode(schema: unknown): schema is TSchema {
  return typeof schema === 'object' && schema !== null
}

function eachChild(schema: TSchema, visit: (child: TSchema) => void): void {
  rebuildChildren(schema, {
    next: (child) => {
      visit(child)
      return child
    },
    intoBranches: true,
  })
}

function scan(schema: TSchema, found: Traits, seen: Set<TSchema>): void {
  if (!isNode(schema) || seen.has(schema))
    return
  seen.add(schema)
  const node = schema as Record<string, unknown>
  found.recursive ||= '$defs' in node || 'definitions' in node || typeof node.$ref === 'string'
  found.cuts ||= excludedOf(schema).length > 0 || isNode(node.if)
  found.defaults ||= 'default' in node
  found.branches ||= Array.isArray(node.anyOf) || Array.isArray(node.oneOf)
  eachChild(schema, child => scan(child, found, seen))
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── The lenient twin: what validation runs against ──────────────────────────
// Validation judges the data as it arrived, before anything is stripped —
// the way the full schema would see it, so `if`, `not`, `oneOf` and friends
// all decide on the real data, and strip() can never flip a branch the Check
// already took. The one difference from the projection itself: every key a
// projection cut is declared again, with its own schema but not required, on
// the node that cut it. That is what lets Type.Read of an
// additionalProperties: false schema accept a full database row — the cut
// `password` is expected there, checked, and removed right after.
const twins = new WeakMap<TSchema, TSchema>()

function twinOf(target: TSchema): TSchema {
  let twin = twins.get(target)
  if (!twin)
    twins.set(target, twin = toTwin(target, { plain: new Map(), exclusive: new Map(), targets: oneOfTargets(target) }))
  return twin
}

// Definitions a $ref under some oneOf points at: those are matched as oneOf
// branches too, so their twins get the exclusive placeholders as well. Found
// by name ($defs/definitions keys, plain or as a "#/$defs/..." pointer) —
// the forms a definition is reached by in practice.
function oneOfTargets(target: TSchema): Set<TSchema> {
  const names = new Set<string>()
  const definitions: [string, TSchema][] = []
  const seen = new Set<TSchema>()
  const walk = (schema: TSchema, underOneOf: boolean): void => {
    if (!isNode(schema) || seen.has(schema))
      return
    seen.add(schema)
    const node = schema as Record<string, unknown>
    if (underOneOf && typeof node.$ref === 'string')
      names.add(node.$ref.replace(/^#\/(?:\$defs|definitions)\//, ''))
    for (const key of ['$defs', 'definitions'] as const) {
      if (isDictionary(node[key]))
        Object.entries(node[key] as Record<string, TSchema>).forEach(entry => definitions.push(entry))
    }
    const oneOf = node.oneOf
    eachChild(schema, child => walk(child, underOneOf || (Array.isArray(oneOf) && oneOf.includes(child))))
  }
  walk(target, false)
  return new Set(definitions.filter(([name]) => names.has(name)).map(([, def]) => def))
}

// Memoized per node within one pass, like project(): a shared subschema
// stays shared in the twin, instead of multiplying with every path to it.
//
// The re-declared key keeps the cut property's own schema — only its
// requiredness is relaxed. A cut field's value is judged exactly as the full
// schema would judge it: a client-supplied readOnly id of the wrong type is
// an error, not something quietly dropped, and a key cut in one place but
// kept by another (an intersection member declaring it too) can never slip
// an otherwise invalid value through. Under a oneOf the cut key keeps its
// requiredness as well: oneOf counts matching branches, and a branch that
// demanded the key must still fail without it.
type TwinPass = { plain: Map<TSchema, TSchema>, exclusive: Map<TSchema, TSchema>, targets: Set<TSchema> }

function toTwin(schema: TSchema, pass: TwinPass, exclusive = false): TSchema {
  if (!isNode(schema))
    return schema
  exclusive ||= pass.targets.has(schema)
  const done = exclusive ? pass.exclusive : pass.plain
  const known = done.get(schema)
  if (known)
    return known
  const twin = twinNode(schema, pass, exclusive)
  done.set(schema, twin)
  return twin
}

function twinNode(schema: TSchema, pass: TwinPass, exclusive: boolean): TSchema {
  const oneOf = (schema as Record<string, unknown>).oneOf
  const { overrides } = rebuildChildren(schema, {
    next: child => toTwin(child, pass, exclusive || (Array.isArray(oneOf) && oneOf.includes(child))),
  })
  const excluded = excludedOf(schema)
  if (excluded.length) {
    const kept = (overrides.properties ?? (schema as Record<string, unknown>).properties ?? {}) as Record<string, TSchema>
    const original = cutSchemasOf(schema)
    const required = new Set<string>()
    const entries: [string, TSchema][] = Object.entries(kept)
    // Each re-declared key goes back where it was when cut — the latest
    // projection pass first, since its indices refer to the node as that pass
    // saw it, and ascending within a pass — so anything order-sensitive in
    // typebox (same-named Type.Cyclic definitions: the later one wins)
    // resolves as on the full schema.
    const cuts = excluded.filter(key => !Object.hasOwn(kept, key))
    const recorded = cuts.filter(key => original.has(key)).sort((a, b) => {
      const x = original.get(a)!
      const y = original.get(b)!
      return y.round - x.round || x.index - y.index
    })
    for (const key of [...recorded, ...cuts.filter(key => !original.has(key))]) {
      const cut = original.get(key)
      // The recorded schema may itself be a projection (Read(Write(S)) cuts a
      // field Write had already projected), so it gets its own twin too.
      // Optional-ness comes from the key being absent from `required` (the
      // projection already took it out) — no Optional() wrapper, which would
      // stop Default from reaching defaults inside the cut value. No recorded
      // schema (cuts carried onto a rebuilt root): anything.
      const placeholder = cut ? toTwin(cut.schema, pass, exclusive) : OriginalType.Optional(OriginalType.Unknown())
      entries.splice(cut ? Math.min(cut.index, entries.length) : entries.length, 0, [key, placeholder])
      if (exclusive && cut?.required)
        required.add(key)
    }
    overrides.properties = Object.assign(Object.create(null), Object.fromEntries(entries))
    if (required.size) {
      const own = (overrides.required ?? (schema as Record<string, unknown>).required) as string[] | undefined
      overrides.required = [...new Set([...(own ?? []), ...required])]
    }
  }
  return Object.keys(overrides).length ? cloneWith(schema, overrides) : schema
}

// ─── strip: removing what a projection cut ───────────────────────────────────
// Runs only on data the twin already accepted — so every node that applies
// to a position (see below) is one the value there satisfies. At each
// position it looks at two sets of schema nodes:
//
// - every node that COULD apply there — all union branches, both Dependent
//   branches, and the Dependent's `if` itself, whose marked fields (it is
//   never projected, since it selects the branch) count as cut all the same.
// - the nodes that DO apply to this value — union branches it matches, the
//   branch its `if` picks, and that `if`.
//
// A key is removed when a node that applies unconditionally cuts it — the
// root, an allOf member, a $ref target, dependentSchemas for a present key,
// the Dependent branch taken, the `if` that matched: all of them describe
// this value whatever else does. A key cut only inside union branches goes
// too, unless a node from a different branch (or from no branch at all)
// declares it outright — an uncut property, or a key its patternProperties
// or additionalProperties schema covers — and really applies. So a variant
// that merely tolerates extra keys never echoes back another variant's
// writeOnly field, a Record beside the cutting member inside the same branch
// rescues nothing, and Type.Union([{ id: Readonly }, { id: String, extra }])
// keeps `id` for a value that is the second variant.
//
// "Really applies" is the one question that needs a Check of a branch
// against the value, and it is asked lazily — only when a declaration could
// rescue a cut key. Ordinary data never asks it, so a long recursive chain
// costs a walk, not a Check per level over the rest of the chain.
//
// $ref is resolved like JSON Schema does: Type.Cyclic's plain names against
// the $defs in scope, anything else as a URI reference against the base URI
// in effect ($id), with JSON pointers (from the resource root, ~0/~1
// unescaped) and $anchor fragments. A $ref that can't be resolved, in a tree
// with cuts to make, fails the validation rather than guessing. `not` is
// never entered — it describes data that must NOT match. Pure and
// copy-on-write: returns the value itself when nothing below changed.
type Flag = 'readOnly' | 'writeOnly'
type Defs = Readonly<Record<string, TSchema>>
type Scope = { defs: Defs, base: string }
// `branch` is the union branch (or `contains`) a root was reached through —
// undefined for a root that applies unconditionally. `confirm` lists the
// "does this branch really match" checks its applicability still rests on:
// run lazily, only when the answer can change what gets removed.
// `flags` (raw roots only): which marks count as cut inside that `if`.
type Root = { schema: TSchema, scope: Scope, raw: boolean, branch?: object, confirm: readonly (() => boolean)[], flags?: readonly Flag[] }
type Index = {
  scopes: WeakMap<object, Scope>
  resources: Map<string, TSchema>
  anchors: Map<string, TSchema>
  refs: Record<string, TSchema>
  ambiguous: Set<string>
}
type StripRun = { flag: Flag, index: Index, checks: Map<TSchema, WeakMap<Defs, WeakMap<object, boolean>>> }

// Thrown out of strip() when a needed $ref leads nowhere; run() turns it
// into an issue.
type Unresolved = Error & { unresolved: string }

function unresolvedRef(ref: string): Unresolved {
  return Object.assign(new Error(`unresolved $ref '${ref}'`), { unresolved: ref })
}

const rootBase = 'https://typebox-standard-schema.invalid/root.json'

function withDefs(defs: Defs, node: Record<string, unknown>): Defs {
  let merged: Record<string, TSchema> | undefined
  for (const key of ['$defs', 'definitions'] as const) {
    if (!isDictionary(node[key]))
      continue
    merged ??= Object.assign(Object.create(null), defs)
    Object.assign(merged!, node[key])
  }
  return merged ?? defs
}

function withoutFragment(uri: string): string {
  const hash = uri.indexOf('#')
  return hash === -1 ? uri : uri.slice(0, hash)
}

const indexes = new WeakMap<TSchema, Index>()

function indexOf(twin: TSchema): Index {
  let index = indexes.get(twin)
  if (index)
    return index
  index = { scopes: new WeakMap(), resources: new Map([[rootBase, twin]]), anchors: new Map(), refs: Object.create(null), ambiguous: new Set() }
  const pending: [string, Scope][] = []
  const visit = (schema: TSchema, parent: Scope): void => {
    if (!isNode(schema) || index!.scopes.has(schema))
      return
    const node = schema as Record<string, unknown>
    let base = parent.base
    if (typeof node.$id === 'string') {
      try {
        base = withoutFragment(new URL(node.$id, base).href)
      }
      catch {}
      if (!index!.resources.has(base))
        index!.resources.set(base, schema)
    }
    const scope: Scope = { defs: withDefs(parent.defs, node), base }
    index!.scopes.set(schema, scope)
    if (typeof node.$anchor === 'string')
      index!.anchors.set(`${base}#${node.$anchor}`, schema)
    if (typeof node.$ref === 'string')
      pending.push([node.$ref, scope])
    eachChild(schema, child => visit(child, scope))
  }
  visit(twin, { defs: Object.create(null), base: rootBase })
  // Every $ref string in the tree, resolved where it sits — the context
  // typebox looks refs up in, when strip() asks whether a subschema matches.
  // The same string meaning different things in different resources can't
  // live in one context; such refs are ambiguous (see matches()).
  for (const [ref, scope] of pending) {
    const target = resolve(index, ref, scope)
    if (!target)
      continue
    if (ref in index.refs && index.refs[ref] !== target)
      index.ambiguous.add(ref)
    else
      index.refs[ref] = target
  }
  indexes.set(twin, index)
  return index
}

function resolve(index: Index, ref: string, scope: Scope): TSchema | undefined {
  if (scope.defs[ref])
    return scope.defs[ref]
  let url: URL
  try {
    url = new URL(ref, scope.base)
  }
  catch {
    return undefined
  }
  const resource = withoutFragment(url.href)
  const document = index.resources.get(resource)
  if (!document || url.hash === '' || url.hash === '#')
    return document
  if (!url.hash.startsWith('#/'))
    return index.anchors.get(`${resource}#${decodeURIComponent(url.hash.slice(1))}`)
  let node: unknown = document
  for (const raw of url.hash.slice(2).split('/')) {
    const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isNode(node) || !Object.hasOwn(node, segment))
      return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return isNode(node) ? node : undefined
}

// The context a subschema is checked in: exactly the refs it leaves free,
// each resolved where the subschema sits. Nothing more — a definition the
// subschema binds itself (a whole Type.Cyclic) must not be shadowed by a
// same-named one from elsewhere in the target.
const contexts = new WeakMap<TSchema, WeakMap<Defs, Defs>>()

function contextOf(run: StripRun, root: Root): Defs {
  let byScope = contexts.get(root.schema)
  if (!byScope)
    contexts.set(root.schema, byScope = new WeakMap())
  let context = byScope.get(root.scope.defs)
  if (!context) {
    const entries: Record<string, TSchema> = Object.create(null)
    for (const ref of freeRefsOf(root.schema)) {
      const target = root.scope.defs[ref] ?? run.index.refs[ref]
      if (target)
        entries[ref] = target
    }
    byScope.set(root.scope.defs, context = liftNested(entries))
  }
  return context
}

// Compiled per (subschema, context), like the target itself: a branch is
// checked by JIT code, not by the interpreter — no deep recursion of our own
// on long recursive data.
const branchValidators = compiledCache<TSchema, WeakMap<Defs, Validator>>()

function branchValidator(schema: TSchema, context: Defs): Validator {
  let byContext = branchValidators().get(schema)
  if (!byContext)
    branchValidators().set(schema, byContext = new WeakMap())
  let validator = byContext.get(context)
  if (!validator)
    byContext.set(context, validator = Compile(context as Record<string, TSchema>, schema))
  return validator
}

// The $ref strings a subschema leaves free: those no $defs inside the same
// subschema binds (a whole Type.Cyclic resolves its own names).
const freeRefs = new WeakMap<TSchema, ReadonlySet<string>>()

function freeRefsOf(schema: TSchema): ReadonlySet<string> {
  let found = freeRefs.get(schema)
  if (!found) {
    const collected = new Set<string>()
    collectFreeRefs(schema, new Set(), new Set(), collected)
    freeRefs.set(schema, found = collected)
  }
  return found
}

function collectFreeRefs(schema: TSchema, bound: ReadonlySet<string>, seen: Set<TSchema>, out: Set<string>): void {
  if (!isNode(schema) || seen.has(schema))
    return
  seen.add(schema)
  const node = schema as Record<string, unknown>
  let names = bound
  for (const key of ['$defs', 'definitions'] as const) {
    if (isDictionary(node[key]))
      names = new Set([...names, ...Object.keys(node[key] as object)])
  }
  if (typeof node.$ref === 'string' && !names.has(node.$ref))
    out.add(node.$ref)
  eachChild(schema, child => collectFreeRefs(child, names, seen, out))
}

// Whether a subschema leans on a free $ref string that means different
// things in different resources — no single context can answer for it.
function usesAmbiguousRef(run: StripRun, schema: TSchema): boolean {
  if (!run.index.ambiguous.size)
    return false
  for (const ref of freeRefsOf(schema)) {
    if (run.index.ambiguous.has(ref))
      return true
  }
  return false
}

// An ambiguous answer counts as "no match": the branch then can't keep a key
// another branch cut — erring towards removing, never towards leaking.
function matches(run: StripRun, root: Root, value: unknown): boolean {
  if (usesAmbiguousRef(run, root.schema))
    return false
  const context = contextOf(run, root)
  if (typeof value !== 'object' || value === null)
    return branchValidator(root.schema, context).Check(value)
  let byContext = run.checks.get(root.schema)
  if (!byContext)
    run.checks.set(root.schema, byContext = new WeakMap())
  let memo = byContext.get(context)
  if (!memo)
    byContext.set(context, memo = new WeakMap())
  let hit = memo.get(value)
  if (hit === undefined)
    memo.set(value, hit = branchValidator(root.schema, context).Check(value))
  return hit
}

function once(check: () => boolean): () => boolean {
  let answer: boolean | undefined
  return () => (answer ??= check())
}

function scopeOf(run: StripRun, schema: TSchema, fallback: Scope): Scope {
  return run.index.scopes.get(schema) ?? fallback
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

// A cheap, conservative "can't possibly match": wrong JSON type, a
// different `const`, or a property whose `const` the value contradicts (the
// discriminator of a tagged union). Never wrong when it says no.
function ruledOut(run: StripRun, schema: TSchema, scope: Scope, value: unknown, depth = 0): boolean {
  const node = schema as Record<string, unknown>
  if (!isNode(node) || depth > 8)
    return false
  if (typeof node.$ref === 'string') {
    const target = resolve(run.index, node.$ref, scope)
    return target ? ruledOut(run, target, scopeOf(run, target, scope), value, depth + 1) : false
  }
  if (typeof node.type === 'string' && !typeFits(node.type, value))
    return true
  if (Array.isArray(node.type) && !node.type.some(type => typeFits(type, value)))
    return true
  if ('const' in node && (typeof node.const !== 'object' || node.const === null) && node.const !== value)
    return true
  if (isDictionary(value) && isDictionary(node.properties)) {
    for (const [key, property] of Object.entries(node.properties)) {
      if (!Object.hasOwn(value, key) || !isDictionary(property) || !('const' in property))
        continue
      const expected = property.const
      if ((typeof expected !== 'object' || expected === null) && expected !== value[key])
        return true
    }
  }
  return false
}

function expand(run: StripRun, roots: Root[], value: unknown, taken: boolean): Root[] {
  const out: Root[] = []
  const seen = new Map<TSchema, Set<object | undefined>[]>()
  const visit = (root: Root): void => {
    const node = root.schema as Record<string, unknown>
    if (!isNode(node))
      return
    const marks = seen.get(root.schema) ?? [new Set(), new Set()]
    seen.set(root.schema, marks)
    const visited = marks[Number(root.raw)]!
    if (visited.has(root.branch))
      return
    visited.add(root.branch)
    out.push(root)
    const next = (schema: unknown, change: Partial<Root> = {}): void => {
      if (isNode(schema))
        visit({ ...root, schema, scope: scopeOf(run, schema, root.scope), ...change })
    }

    if (typeof node.$ref === 'string') {
      const target = resolve(run.index, node.$ref, root.scope)
      if (!target)
        throw unresolvedRef(node.$ref)
      next(target)
    }
    if (Array.isArray(node.allOf))
      node.allOf.forEach(member => next(member))
    if (isDictionary(value)) {
      for (const key of ['dependentSchemas', 'dependencies'] as const) {
        if (isDictionary(node[key])) {
          for (const [name, sub] of Object.entries(node[key] as object)) {
            if (Object.hasOwn(value, name) && !Array.isArray(sub))
              next(sub)
          }
        }
      }
    }
    for (const key of ['anyOf', 'oneOf'] as const) {
      if (!Array.isArray(node[key]))
        continue
      const branches = (node[key] as unknown[]).filter(isNode)
      if (!taken) {
        branches.forEach(branch => next(branch, { branch }))
        continue
      }
      // Every node visited here applies to the value, so one of its branches
      // matches: a lone survivor of the cheap filter is it. Otherwise each
      // candidate carries a deferred check, run only if its say matters.
      const candidates = branches.filter(branch => !ruledOut(run, branch, scopeOf(run, branch, root.scope), value))
      for (const branch of candidates) {
        const candidate: Root = { ...root, schema: branch, scope: scopeOf(run, branch, root.scope) }
        const confirm = candidates.length === 1 ? root.confirm : [...root.confirm, once(() => matches(run, candidate, value))]
        next(branch, { branch, confirm })
      }
    }
    if (isNode(node.if)) {
      const flags = ifFlagsOf(root.schema) ?? [run.flag]
      // In the "could apply" set the `if` is a branch of its own: when it
      // didn't match, a declaration in the `else` taken may keep the key.
      if (!taken) {
        next(node.if, { raw: true, flags, branch: node.if as object })
        next(node.then, { branch: node.then as object })
        next(node.else, { branch: node.else as object })
      }
      else if (matches(run, { ...root, schema: node.if, scope: scopeOf(run, node.if, root.scope), raw: true }, value)) {
        next(node.if, { raw: true, flags })
        next(node.then)
      }
      else {
        next(node.else)
      }
    }
  }
  roots.forEach(visit)
  return out
}

function propertiesOf(root: Root): Record<string, unknown> | undefined {
  const properties = (root.schema as Record<string, unknown>).properties
  return isDictionary(properties) ? properties : undefined
}

// Keys this node cuts: recorded by the projection — and inside an `if`,
// which is never projected, also those marked with the flag directly.
function cutsOf(run: StripRun, root: Root): readonly string[] {
  const recorded = excludedOf(root.schema)
  if (!root.raw)
    return recorded
  const properties = propertiesOf(root)
  const flags = root.flags ?? [run.flag]
  const marked = properties ? Object.keys(properties).filter(key => flags.some(flag => (properties[key] as Record<string, unknown> | undefined)?.[flag])) : []
  return [...recorded, ...marked]
}

const patternCache = new WeakMap<object, [RegExp, unknown][]>()

function patternsOf(root: Root): [RegExp, unknown][] {
  const patternProperties = (root.schema as Record<string, unknown>).patternProperties
  if (!isDictionary(patternProperties))
    return []
  let patterns = patternCache.get(patternProperties)
  if (!patterns)
    patternCache.set(patternProperties, patterns = Object.entries(patternProperties).map(([source, schema]) => [new RegExp(source, 'u'), schema]))
  return patterns
}

// The subschema a node holds for `key`: its property, a matching pattern, or
// its additionalProperties schema. unevaluatedProperties is not among them —
// it only covers keys nothing else at this position evaluated (children()).
function childOf(root: Root, key: string): unknown {
  const properties = propertiesOf(root)
  if (properties && Object.hasOwn(properties, key))
    return properties[key]
  const pattern = patternsOf(root).find(([regexp]) => regexp.test(key))
  if (pattern)
    return pattern[1]
  const node = root.schema as Record<string, unknown>
  return isNode(node.additionalProperties) ? node.additionalProperties : undefined
}

// An `if` describes nothing — it is a condition — so a raw node never
// declares a key, however it spells it; nor does unevaluatedProperties.
function declares(root: Root, key: string): boolean {
  if (root.raw)
    return false
  const properties = propertiesOf(root)
  if (properties && Object.hasOwn(properties, key))
    return !excludedOf(root.schema).includes(key)
  return childOf(root, key) !== undefined
}

function itemOf(root: Root, index: number): unknown {
  const node = root.schema as Record<string, unknown>
  const positional = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : undefined
  if (positional && index < positional.length)
    return positional[index]
  const rest = Array.isArray(node.prefixItems) ? node.items : Array.isArray(node.items) ? node.additionalItems : node.items
  return isNode(rest) ? rest : undefined
}

// Child roots for one key or index. unevaluatedProperties/unevaluatedItems
// join only where no node at this position evaluated the element otherwise.
function children(run: StripRun, roots: Root[], pick: (root: Root) => unknown, unevaluated: 'unevaluatedProperties' | 'unevaluatedItems'): Root[] {
  const out: Root[] = []
  for (const root of roots) {
    const child = pick(root)
    if (isNode(child))
      out.push({ ...root, schema: child, scope: scopeOf(run, child, root.scope) })
  }
  if (out.length)
    return out
  for (const root of roots) {
    const child = (root.schema as Record<string, unknown>)[unevaluated]
    if (isNode(child))
      out.push({ ...root, schema: child, scope: scopeOf(run, child, root.scope) })
  }
  return out
}

// `contains` applies to the items that match it: always a candidate for
// cuts; applicable — as a branch of its own, with a deferred check — too.
function containsRoots(run: StripRun, roots: Root[], item: unknown): Root[] {
  const out: Root[] = []
  for (const root of roots) {
    const contains = (root.schema as Record<string, unknown>).contains
    if (!isNode(contains))
      continue
    const candidate: Root = { ...root, schema: contains, scope: scopeOf(run, contains, root.scope), branch: contains }
    out.push({ ...candidate, confirm: [...root.confirm, once(() => matches(run, candidate, item))] })
  }
  return out
}

// A copy that can take any key — '__proto__' included — as an own property.
function copyOf(source: object): Record<string, unknown> {
  const copy = Object.create(Object.getPrototypeOf(source)) as Record<string, unknown>
  for (const key of Object.keys(source))
    define(copy, key, (source as Record<string, unknown>)[key])
  return copy
}

function define(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

// Whether `key` stays at this position: no unconditional node cuts it, and
// every branch that cuts it is outweighed by a node from another branch (or
// none) that declares it and does apply — the only place a deferred
// branch check ever runs.
function keeps(run: StripRun, all: Root[], applicable: Root[], key: string): boolean {
  if (applicable.some(root => root.branch === undefined && cutsOf(run, root).includes(key)))
    return false
  const cutters = all.filter(root => cutsOf(run, root).includes(key))
  if (!cutters.length)
    return true
  const branches = new Set(cutters.map(root => root.branch))
  return applicable.some(root => !branches.has(root.branch) && declares(root, key) && root.confirm.every(check => check()))
}

function strip(run: StripRun, value: unknown, every: Root[], taken: Root[]): unknown {
  if (typeof value !== 'object' || value === null || !every.length)
    return value
  const all = expand(run, every, value, false)
  const applicable = expand(run, taken, value, true)

  if (Array.isArray(value)) {
    let out: unknown[] | undefined
    value.forEach((item, index) => {
      const next = strip(
        run,
        item,
        [...children(run, all, root => itemOf(root, index), 'unevaluatedItems'), ...containsRoots(run, all, item)],
        [...children(run, applicable, root => itemOf(root, index), 'unevaluatedItems'), ...containsRoots(run, applicable, item)],
      )
      if (next !== item)
        (out ??= value.slice())[index] = next
    })
    return out ?? value
  }

  const source = value as Record<string, unknown>
  let out: Record<string, unknown> | undefined
  for (const key of Object.keys(source)) {
    if (!keeps(run, all, applicable, key)) {
      out ??= copyOf(source)
      delete out[key]
      continue
    }
    // A node that cuts `key` has nothing to say about what is under it — in
    // its reading the key is gone — so it adds no applicable children there.
    const below = applicable.filter(root => !cutsOf(run, root).includes(key))
    const next = strip(run, source[key], children(run, all, root => childOf(root, key), 'unevaluatedProperties'), children(run, below, root => childOf(root, key), 'unevaluatedProperties'))
    if (next !== source[key])
      define(out ??= copyOf(source), key, next)
  }
  return out ?? value
}

function stripCuts(twin: TSchema, target: TSchema, value: unknown): unknown {
  const index = indexOf(twin)
  const run: StripRun = { flag: modeOf(target) === 'read' ? 'writeOnly' : 'readOnly', index, checks: new Map() }
  const root: Root = { schema: twin, scope: scopeOf(run, twin, { defs: Object.create(null), base: rootBase }), raw: false, confirm: [] }
  return strip(run, value, [root], [root])
}

function isUnresolved(error: unknown): error is Unresolved {
  return error instanceof Error && typeof (error as Unresolved).unresolved === 'string'
}

// ─── Cloning the input ───────────────────────────────────────────────────────
// The input must be cloned before Convert (it mutates), and a validator must
// never throw on data it was asked to judge. structuredClone is the fast path
// but throws DataCloneError on functions, symbols and other uncloneables —
// exactly the payloads a validator gets handed by mistake (event objects,
// class instances with methods). The fallback reconstructs the host types
// with hidden internal state (Date/RegExp/Map/Set/ArrayBuffer and its views)
// — Object.entries sees none of their data, so naively flattening them would
// corrupt them — and otherwise flattens every object, generic class
// instances included, into a fresh plain object of its own enumerable
// properties. That mirrors what structuredClone itself would have done for
// such an instance (it has no concept of "atomic passthrough" for arbitrary
// classes); the alternative, sharing it by reference, would let
// Convert/Default write into a schema-described position on the caller's
// original object — only reached because *something* elsewhere in the graph,
// not necessarily this node, defeated structuredClone. Cycles are preserved
// via the seen map (structuredClone survives them, so the fallback must too),
// and so are array holes.
function cloneValue(data: unknown): unknown {
  if (typeof data !== 'object' || data === null)
    return data
  try {
    return structuredClone(data)
  }
  catch {
    return cloneShape(data, new WeakMap())
  }
}

function remember<T>(seen: WeakMap<object, unknown>, original: object, clone: T): T {
  seen.set(original, clone)
  return clone
}

// %TypedArray%.prototype.slice always copies — unlike Buffer's own slice,
// which returns a view sharing the caller's memory.
const copyTypedArray = Object.getPrototypeOf(Uint8Array.prototype).slice as (this: ArrayBufferView) => ArrayBufferView

function cloneShape(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null)
    return value
  const memoized = seen.get(value)
  if (memoized)
    return memoized

  if (Array.isArray(value)) {
    const clone: unknown[] = []
    clone.length = value.length // holes stay holes: forEach below skips them
    seen.set(value, clone)
    value.forEach((child, index) => {
      clone[index] = cloneShape(child, seen)
    })
    return clone
  }
  if (value instanceof Date)
    return remember(seen, value, new Date(value.getTime()))
  if (value instanceof RegExp)
    return remember(seen, value, new RegExp(value.source, value.flags))
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>()
    seen.set(value, clone)
    for (const [k, v] of value) clone.set(cloneShape(k, seen), cloneShape(v, seen))
    return clone
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>()
    seen.set(value, clone)
    for (const v of value) clone.add(cloneShape(v, seen))
    return clone
  }
  if (value instanceof ArrayBuffer)
    return remember(seen, value, value.slice(0))
  if (value instanceof DataView)
    return remember(seen, value, new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)))
  if (ArrayBuffer.isView(value))
    return remember(seen, value, copyTypedArray.call(value))

  // defineProperty, not assignment: a property literally named '__proto__'
  // must become an own key here, not trigger Object.prototype's accessor and
  // repoint this object's prototype instead of holding the field.
  const clone: Record<string, unknown> = {}
  seen.set(value, clone)
  for (const [key, child] of Object.entries(value)) define(clone, key, cloneShape(child, seen))
  return clone
}

// Only a schema that can recurse into itself (a Type.Cyclic somewhere in its
// tree) is at risk from cyclic data: Convert/Default/Check otherwise recurse
// exactly as deep as the schema's own finite structure goes, then bottom out
// — matching or failing type-check there — no matter how the data cycles.
// A non-recursive schema pointed at cyclic data it doesn't even describe is
// therefore never at risk, and skipping the check there matters: it would
// otherwise reject perfectly fine payloads whose only cyclic part is
// irrelevant to the schema.
//
// A synchronous stack overflow, not a validation failure, is what a
// recursive schema gets from typebox's own Check/Convert/Default when handed
// data with a genuine object-identity cycle — none of them track a visited
// set. Checked up front, before any of them run, on data already cloned by
// cloneValue (which preserves cycles on either path, so this sees the same
// shape the original had either way). Iterative, with an explicit stack: a
// deep but acyclic payload must not overflow the very check guarding against
// overflow. A value reached twice without a cycle (a shared reference) is
// finished, not on the path, and doesn't count.
function hasCycle(root: unknown): boolean {
  if (typeof root !== 'object' || root === null)
    return false
  const onPath = new Set<object>()
  const done = new Set<object>()
  const stack: { value: object, children: unknown[], next: number }[] = []
  const enter = (value: object): void => {
    onPath.add(value)
    stack.push({ value, children: Array.isArray(value) ? value : Object.values(value), next: 0 })
  }
  enter(root)
  while (stack.length) {
    const frame = stack[stack.length - 1]!
    if (frame.next === frame.children.length) {
      stack.pop()
      onPath.delete(frame.value)
      done.add(frame.value)
      continue
    }
    const child = frame.children[frame.next++]
    if (typeof child !== 'object' || child === null || done.has(child))
      continue
    if (onPath.has(child))
      return true
    enter(child)
  }
  return false
}

function unreadableIssue(error: unknown): ValidationIssue {
  return {
    keyword: 'unreadable',
    message: error instanceof Error ? error.message : String(error),
    params: {},
    path: [],
  }
}

function circularIssue(): ValidationIssue {
  return { keyword: 'circular', message: 'circular reference is not supported', params: {}, path: [] }
}

function depthIssue(): ValidationIssue {
  return { keyword: 'depth', message: 'value is nested too deeply to validate', params: {}, path: [] }
}

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message)
}

// Shared pipeline: Clone → Convert (coerce FormData strings → numbers/
// booleans) → Default → Check against the lenient twin (the data as it
// arrived, cut fields optional) → strip (delete what the projection cut).
// Convert and Default run on the twin too, so they see the same shape the
// Check does. The return shape is the Standard Schema v1 result.
function run(target: TSchema, data: unknown): { value: unknown } | { issues: ValidationIssue[] } {
  const { recursive, cuts } = traitsOf(target)
  const twin = cuts ? twinOf(target) : target
  // The twin, not the target: a cut field's schema comes back in it, defaults
  // and all.
  const { defaults } = traitsOf(twin)
  const validator = compiledFor(twin)

  let cloned: unknown
  try {
    cloned = cloneValue(data)
  }
  catch (error) {
    // Reading `data` failed outright — a throwing getter is the realistic
    // cause, during structuredClone's own read or cloneShape's fallback walk.
    // That is a property of the data, not of the schema or its compilation,
    // so it becomes an ordinary issue instead of an uncaught exception. So is
    // data nested deeper than the clone itself can recurse.
    return { issues: [isStackOverflow(error) ? depthIssue() : unreadableIssue(error)] }
  }

  if (recursive && hasCycle(cloned))
    return { issues: [circularIssue()] }

  try {
    // One value throughout: defaulted and converted by the twin — the data as
    // the full schema sees it, a cut field with its own defaults — is what
    // the Check judges, what strip() matches branches against, and what is
    // handed back minus the cuts. Defaulting after the strip instead would let
    // a union's other branch default its way into the result. Defaults come
    // first, as in TypeBox's own Parse: a missing value gets its default, not
    // whatever Convert would make of `undefined`.
    const defaulted = defaults ? applyDefaults(twin, cloned) : cloned
    // Data that already passes needs no conversion (Convert leaves valid
    // values as they are) — the common case, and Convert is the costly stage.
    const coerced = validator.Check(defaulted) ? defaulted : convert(twin, defaulted)
    return judge(validator, twin, target, cuts, coerced)
  }
  catch (error) {
    // Ways data alone overflows typebox's natively recursive walkers: a
    // recursive schema following acyclic data as deep as it goes; a union's
    // Convert/Default cloning the whole value, cycles included, whether or
    // not the schema describes them; and Convert chasing a self-referencing
    // hand-written schema ($ref: '#' under anyOf) in circles. For acyclic
    // data the value is judged once more without the coercion stages — a
    // valid payload still passes. Only an overflow is caught, and only here,
    // in the data phase — the schema compiled above, outside this try, so a
    // broken schema still throws loudly.
    if (!isStackOverflow(error))
      throw error
    if (hasCycle(cloned))
      return { issues: [circularIssue()] }
    try {
      return judge(validator, twin, target, cuts, cloned)
    }
    catch (retry) {
      if (isStackOverflow(retry))
        return { issues: [depthIssue()] }
      throw retry
    }
  }
}

function judge(validator: Validator, twin: TSchema, target: TSchema, cuts: boolean, value: unknown): { value: unknown } | { issues: ValidationIssue[] } {
  if (!validator.Check(value)) {
    const { recursive, branches } = traitsOf(twin)
    const errors = recursive && branches ? collectErrors(twin, value) : validator.Errors(value)
    return { issues: toIssues(errors as CompiledError[], value) }
  }
  if (!cuts)
    return { value }
  try {
    return { value: stripCuts(twin, target, value) }
  }
  catch (error) {
    if (!isUnresolved(error))
      throw error
    return { issues: [{ keyword: '$ref', message: `cannot resolve $ref '${error.unresolved}' to remove projected fields`, params: { $ref: error.unresolved }, path: [] }] }
  }
}

// General-purpose validation utility. A full schema validates against its
// write projection (inputs are the common case); a projection obtained from
// Type.Read/Type.Write validates as itself. The returned data is typed as that
// same target — a full schema hands back its input shape, without the readOnly
// fields the projection stripped.
export function validate<T extends TSchema>(schema: T, data: unknown): ValidationResult<Static<TValidated<T>>> {
  const result = run(targetOf(schema), data)

  if ('value' in result)
    return { success: true, data: result.value as Static<TValidated<T>> }

  return { success: false, errors: result.issues }
}

// The interface belongs to the schema it is read from, not to the one it was
// attached to. That distinction matters because cloneWith() copies own
// descriptors: every projection, mark and named clone inherits this property
// from its source. A plain value would drag the source's closure along and
// validate the wrong shape (a read projection asking for writeOnly fields); an
// accessor resolves the target from the receiver instead. Memoized per schema,
// so repeated reads hand back the same object.
const standards = new WeakMap<TSchema, StandardProps>()

function standardOf(this: TSchema): StandardProps {
  let props = standards.get(this)
  if (!props)
    standards.set(this, props = standardFor(this))

  return props
}

function standardFor(schema: TSchema): StandardProps {
  return {
    version: 1,
    vendor: 'typebox',
    validate: value => run(targetOf(schema), value),
    jsonSchema: {
      input: options => emitJsonSchema(targetOf(schema), 'input', options),
      output: options => emitJsonSchema(targetOf(schema), 'output', options),
    },
  }
}

// The error parse() throws. A branded plain Error, not a class (this codebase
// has none): the name plus the issues payload are what catch-sites need, and
// isValidationError() is the supported way to tell it apart.
export type ValidationError = Error & {
  readonly name: 'ValidationError'
  readonly issues: readonly ValidationIssue[]
}

// Duck-typed rather than instanceof: an error thrown across a realm boundary
// (vm, worker, iframe) is not an instance of this realm's Error, yet is still
// ours to recognize. The three checked members are exactly the contract
// catch-sites rely on.
export function isValidationError(error: unknown): error is ValidationError {
  return typeof error === 'object' && error !== null
    && (error as Error).name === 'ValidationError'
    && typeof (error as Error).message === 'string'
    && Array.isArray((error as ValidationError).issues)
}

function validationError(issues: ValidationIssue[]): ValidationError {
  const shown = issues.slice(0, 3)
    .map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
  const rest = issues.length - 3
  const error = new Error(rest > 0 ? `${shown}; +${rest} more` : shown)
  error.name = 'ValidationError'
  return Object.assign(error, { issues }) as ValidationError
}

// Assert-style counterpart of validate(): returns the validated data or throws
// a ValidationError carrying the same issues. Same target rules — a full
// schema parses its write projection, a projection parses itself.
export function parse<T extends TSchema>(schema: T, data: unknown): Static<TValidated<T>> {
  const result = run(targetOf(schema), data)

  if ('value' in result)
    return result.value as Static<TValidated<T>>

  throw validationError(result.issues)
}

// The accessor lives on a shared PROTOTYPE, not on the schema itself. Two
// forces picked this spot:
//
// - It must be a getter resolving from the receiver (`this`), or clones would
//   inherit a closure over the wrong schema and validate the wrong shape.
// - It must NOT be an own property: typebox ≥1.3.13 clones schemas internally
//   (Partial, Optional, ...) by copying own descriptors and assigning
//   `descriptor.value` — on an accessor descriptor that builds an invalid
//   get+value mix and throws "Invalid property". An inherited accessor is
//   invisible to that walk; typebox's clones come out as plain objects and
//   pick ~standard back up at our factory exits.
//
// Everything else follows: prototype members never reach JSON.stringify or
// Object.keys, our own cloneWith() preserves the prototype (clones stay
// Standard Schemas with receiver-bound targets), and a spread copy loses the
// interface exactly as it loses typebox's non-enumerable markers.
const standardHost = Object.create(Object.prototype, {
  '~standard': {
    get: standardOf,
    enumerable: false,
    configurable: true,
  },
}) as object

// Injects the Standard Schema v1 interface onto a schema object (idempotent,
// invisible to JSON Schema output). Everything heavy is deferred to the first
// validate() call: target resolution and JIT compilation happen only where
// ~standard is actually exercised.
export function attachStandard<T extends TSchema>(schema: T): T {
  // Any present interface is left alone: ours (inherited via the prototype,
  // already bound to the receiver) and a foreign vendor's own property alike —
  // adopt() must not overwrite it.
  // A boolean subschema (`true`/`false`) is legal JSON Schema but no object
  // to attach anything to.
  if (typeof schema !== 'object' || schema === null || '~standard' in schema)
    return schema

  Object.setPrototypeOf(schema, standardHost)
  return schema
}
