// Standard JSON Schema (https://standardschema.dev/json-schema): the
// `~standard.jsonSchema.input()/output()` half of the interface.
//
// Turns the validation target of a schema (what targetOf() returns: the schema
// itself for a Read/Write projection, its write projection for a full schema)
// into a clean, fresh, plain-JSON JSON Schema for one of three targets. The
// projection has already cut the fields; this module only normalizes the
// result. It works on plain JSON and knows nothing about typebox.

export type JsonSchemaTarget = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | (string & {})

// `libraryOptions` (all optional, unknown keys ignored):
//
// - keepIds: boolean        keep `$id` (stripped by default)
// - inlineRoot: boolean     inline a root that is only a `$ref`, as produced by
//                           Type.Cyclic (default true)
// - components: object      openapi-3.0 only: a bag the recursive definitions
//                           are written to (`components.schemas`), referenced
//                           as `#/components/schemas/<Name>`
export type JsonSchemaOptions = {
  readonly target: JsonSchemaTarget
  readonly libraryOptions?: Record<string, unknown> | undefined
}

export type JsonSchemaIo = 'input' | 'output'

type Node = Record<string, unknown>
type Scope = Map<string, string>

const supported = ['draft-2020-12', 'draft-07', 'openapi-3.0'] as const
const jsonTypes = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])
const headers: Record<string, string> = {
  'draft-2020-12': 'https://json-schema.org/draft/2020-12/schema',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
}
const refPrefix: Record<string, string> = {
  'draft-2020-12': '#/$defs/',
  'draft-07': '#/definitions/',
  'openapi-3.0': '#/components/schemas/',
}

function fail(message: string): never {
  throw new Error(`typebox-standard-schema: ${message}`)
}

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function unique(items: unknown[]): unknown[] {
  return items.filter((item, index) => items.findIndex(other => same(other, item)) === index)
}

// ─── Structural walk over a plain JSON tree ─────────────────────────────────
// Only keyword positions that hold subschemas are visited: `default`, `const`,
// `enum`, `examples` are data and must never be mistaken for schemas.
const schemaMaps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const
const schemaLists = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const
const schemaSingles = ['additionalItems', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties'] as const

// A shallow copy of `node` with every subschema replaced by `f(subschema)`;
// the container keywords named in `skip` are left alone.
function mapChildren(node: Node, f: (child: Node) => Node, skip: readonly string[] = []): Node {
  const out: Node = { ...node }
  const apply = (child: unknown): unknown => (isNode(child) ? f(child) : child)
  for (const key of schemaMaps) {
    const map = node[key]
    if (!skip.includes(key) && isNode(map))
      out[key] = Object.fromEntries(Object.entries(map).map(([name, child]) => [name, apply(child)]))
  }
  for (const key of schemaLists) {
    const list = node[key]
    if (Array.isArray(list))
      out[key] = list.map(apply)
  }
  for (const key of schemaSingles) {
    const child = node[key]
    if (isNode(child))
      out[key] = f(child)
  }
  if (Array.isArray(node.items))
    out.items = node.items.map(apply)
  else if (isNode(node.items))
    out.items = f(node.items)
  if (isNode(node.dependencies))
    out.dependencies = Object.fromEntries(Object.entries(node.dependencies).map(([name, child]) => [name, Array.isArray(child) ? child : apply(child)]))
  return out
}

// JSON pointer escaping for a definition name (RFC 6901), plus the inverse.
const encodeName = (name: string): string => name.replaceAll('~', '~0').replaceAll('/', '~1')
const decodeName = (name: string): string => decodeURIComponent(name).replaceAll('~1', '/').replaceAll('~0', '~')

// ─── Stage 1: hoist definitions, resolve refs, drop $id ─────────────────────
// typebox's Type.Cyclic emits bare-name refs ({ $ref: 'Node' }) resolved
// against the nearest enclosing $defs entry (whose $id equals its key). Every
// definition, however deeply nested, is lifted to one root map and refs become
// real JSON pointers for the target.
function hoist(root: Node, target: string, keepIds: boolean): { node: Node, defs: Record<string, Node> } {
  const defs: Record<string, Node> = {}
  const sources = new Map<string, string>()
  const ids = new Map<string, Node>()
  function collect(node: Node): void {
    if (typeof node.$id === 'string' && !ids.has(node.$id))
      ids.set(node.$id, node)
    mapChildren(node, (child) => {
      collect(child)
      return child
    })
  }
  collect(root)

  // Two definitions with one name stay apart only if their content differs:
  // identical ones share a slot, different ones get `Name_2`, `Name_3`, ...
  function allocate(key: string, def: Node): { name: string, isNew: boolean } {
    const source = JSON.stringify(def)
    for (let i = 0; ; i++) {
      const name = i === 0 ? key : `${key}_${i + 1}`
      const known = sources.get(name)
      if (known === undefined) {
        sources.set(name, source)
        defs[name] = {} // reserve the slot so recursion finds it
        return { name, isNew: true }
      }
      if (known === source)
        return { name, isNew: false }
    }
  }

  function resolve(ref: string, scopes: Scope[]): string {
    const pointer = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref)
    const key = pointer ? decodeName(pointer[1]!) : ref
    if (pointer || !/[:/#]/.test(ref)) {
      for (const scope of scopes) {
        const hit = scope.get(key)
        if (hit !== undefined)
          return refPrefix[target]! + encodeName(hit)
      }
      const byId = pointer ? undefined : ids.get(ref)
      if (byId) {
        const { name, isNew } = allocate(ref, byId)
        if (isNew)
          defs[name] = visit(byId, scopes)
        return refPrefix[target]! + encodeName(name)
      }
      fail(`cannot resolve $ref "${ref}"`)
    }
    return ref // '#', other pointers and absolute URIs stay as written
  }

  function visit(node: Node, scopes: Scope[]): Node {
    let local = scopes
    const containers = (['$defs', 'definitions'] as const).filter(key => isNode(node[key]))
    if (containers.length) {
      const scope: Scope = new Map()
      const fresh: Array<[string, Node]> = []
      for (const container of containers) {
        for (const [key, def] of Object.entries(node[container] as Node)) {
          if (!isNode(def))
            continue
          const { name, isNew } = allocate(key, def)
          scope.set(key, name)
          if (typeof def.$id === 'string')
            scope.set(def.$id, name)
          if (isNew)
            fresh.push([name, def])
        }
      }
      local = [scope, ...scopes]
      for (const [name, def] of fresh)
        defs[name] = visit(def, local)
    }
    const out = mapChildren(node, child => visit(child, local), ['$defs', 'definitions'])
    delete out.$defs
    delete out.definitions
    if (typeof out.$ref === 'string')
      out.$ref = resolve(out.$ref, local)
    if (!keepIds)
      delete out.$id
    return out
  }

  return { node: visit(root, []), defs }
}

// ─── Stage 2: per-node rules (representability, io, target) ─────────────────
const nullSchema = (): Node => ({ nullable: true, enum: [null] })

// A node is the null schema if it has exactly its two keys, in any order.
const isNullSchema = (value: unknown): boolean => isNode(value) && Object.keys(value).length === 2 && value.nullable === true && same(value.enum, [null])

function adapt(n: Node, io: JsonSchemaIo, target: string): Node {
  // Representability: typebox has kinds with no JSON Schema meaning.
  const types = Array.isArray(n.type) ? n.type : n.type === undefined ? [] : [n.type]
  for (const type of types) {
    if (typeof type !== 'string' || !jsonTypes.has(type))
      fail(`type ${JSON.stringify(type)} has no JSON Schema representation`)
  }

  // Defaults are applied before checking: a defaulted property may be absent
  // from the input, and is always present in the output.
  const properties = isNode(n.properties) ? n.properties : undefined
  if (properties) {
    const withDefault = Object.keys(properties).filter((key) => {
      const property = properties[key]
      return isNode(property) && 'default' in property
    })
    if (withDefault.length) {
      const required = Array.isArray(n.required) ? n.required as string[] : []
      n.required = io === 'input'
        ? required.filter(key => !withDefault.includes(key))
        : [...required, ...withDefault.filter(key => !required.includes(key))]
    }
  }
  if (Array.isArray(n.required) && n.required.length === 0)
    delete n.required

  if (target === 'draft-2020-12') {
    if (Array.isArray(n.items)) {
      n.prefixItems = n.items
      if (n.additionalItems === false)
        n.items = false
      else if (isNode(n.additionalItems))
        n.items = n.additionalItems
      else
        delete n.items
    }
    delete n.additionalItems
    if (isNode(n.dependencies))
      splitDependencies(n, n.dependencies)
  }

  if (target === 'draft-07') {
    for (const key of ['unevaluatedItems', 'unevaluatedProperties', '$dynamicRef', '$dynamicAnchor', '$anchor', 'minContains', 'maxContains']) {
      if (key in n)
        fail(`"${key}" cannot be expressed in draft-07`)
    }
    if (Array.isArray(n.prefixItems)) {
      const rest = n.items
      n.items = n.prefixItems
      delete n.prefixItems
      if (rest !== undefined)
        n.additionalItems = rest
    }
    mergeDependencies(n)
    wrapRefSiblings(n)
  }

  if (target === 'openapi-3.0')
    openapi30(n)

  return n
}

function splitDependencies(n: Node, dependencies: Node): void {
  for (const [key, value] of Object.entries(dependencies)) {
    const slot = Array.isArray(value) ? 'dependentRequired' : 'dependentSchemas'
    n[slot] = { ...(n[slot] as Node | undefined), [key]: value }
  }
  delete n.dependencies
}

function mergeDependencies(n: Node): void {
  if (!isNode(n.dependentRequired) && !isNode(n.dependentSchemas))
    return
  n.dependencies = { ...(n.dependencies as Node | undefined), ...(n.dependentRequired as Node | undefined), ...(n.dependentSchemas as Node | undefined) }
  delete n.dependentRequired
  delete n.dependentSchemas
}

// Draft-07 and OpenAPI 3.0 ignore every sibling of $ref.
function wrapRefSiblings(n: Node): void {
  if (typeof n.$ref !== 'string' || Object.keys(n).length === 1)
    return
  const { $ref, allOf, ...rest } = n
  for (const key of Object.keys(n))
    delete n[key]
  Object.assign(n, rest, { allOf: [{ $ref }, ...(Array.isArray(allOf) ? allOf : [])] })
}

const openapiUnsupported = ['unevaluatedItems', 'unevaluatedProperties', '$dynamicRef', '$dynamicAnchor', 'minContains', 'maxContains', 'contains', 'propertyNames', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'dependencies']

function openapi30(n: Node): void {
  for (const key of openapiUnsupported) {
    if (key in n)
      fail(`"${key}" cannot be expressed in OpenAPI 3.0`)
  }
  for (const key of ['$schema', '$id', '$comment', '$anchor', 'contentEncoding', 'contentMediaType'])
    delete n[key]

  if ('const' in n) {
    n.enum = [n.const]
    delete n.const
  }
  if (Array.isArray(n.examples)) {
    if (n.examples.length && !('example' in n))
      n.example = n.examples[0]
    delete n.examples
  }

  // type arrays: 'null' becomes nullable, several types become an anyOf
  if (Array.isArray(n.type)) {
    const kinds = (n.type as string[]).filter(type => type !== 'null')
    if (kinds.length !== n.type.length)
      n.nullable = true
    if (kinds.length === 1) {
      n.type = kinds[0]
    }
    else {
      delete n.type
      if (kinds.length)
        n.anyOf = [...(Array.isArray(n.anyOf) ? n.anyOf : []), ...kinds.map(type => ({ type }))]
      else
        Object.assign(n, { enum: [null] })
    }
  }
  else if (n.type === 'null') {
    delete n.type
    Object.assign(n, nullSchema())
  }
  // anyOf: [X, null] with a typed X folds into X { nullable }
  if (Array.isArray(n.anyOf) && n.anyOf.length === 2) {
    const members = n.anyOf as unknown[]
    const index = members.findIndex(isNullSchema)
    const other = members[1 - index]
    if (index >= 0 && isNode(other) && typeof other.type === 'string' && !('$ref' in other) && !('nullable' in other)) {
      delete n.anyOf
      Object.assign(n, other, { nullable: true })
    }
  }

  // numeric exclusive bounds -> boolean form
  for (const [bound, flag] of [['minimum', 'exclusiveMinimum'], ['maximum', 'exclusiveMaximum']] as const) {
    const exclusive = n[flag]
    const inclusive = n[bound]
    if (typeof exclusive === 'number') {
      const stricter = typeof inclusive !== 'number' || (bound === 'minimum' ? exclusive >= inclusive : exclusive <= inclusive)
      if (stricter) {
        n[bound] = exclusive
        n[flag] = true
      }
      else {
        delete n[flag]
      }
    }
  }

  // tuples: positional items become a union item schema with fixed length
  if (Array.isArray(n.prefixItems) || Array.isArray(n.items)) {
    const positional = (Array.isArray(n.prefixItems) ? n.prefixItems : n.items) as unknown[]
    const rest = Array.isArray(n.prefixItems) ? n.items : n.additionalItems
    const members = unique(isNode(rest) ? [...positional, rest] : positional)
    n.items = members.length === 1 ? members[0] : members.length ? { anyOf: members } : {}
    if (!isNode(rest) && rest !== true) {
      n.minItems = Math.max(typeof n.minItems === 'number' ? n.minItems : 0, positional.length)
      n.maxItems = positional.length
    }
    delete n.prefixItems
    delete n.additionalItems
  }
  else if (n.items === false) {
    n.maxItems = 0
    delete n.items
  }
  else {
    delete n.additionalItems
  }

  // Record: patternProperties become additionalProperties
  if (isNode(n.patternProperties)) {
    const values = unique(Object.values(n.patternProperties))
    const value = values.length === 1 ? values[0] : { anyOf: values }
    n.additionalProperties = isNode(n.additionalProperties) ? { anyOf: [value, n.additionalProperties] } : value
    delete n.patternProperties
  }

  wrapRefSiblings(n)
}

function transform(node: Node, io: JsonSchemaIo, target: string): Node {
  return adapt(mapChildren(node, child => transform(child, io, target)), io, target)
}

// OpenAPI 3.0 has no local definitions: inline them, or refuse recursion.
function inline(node: Node, defs: Record<string, Node>, stack: string[]): Node {
  const prefix = refPrefix['openapi-3.0']!
  if (typeof node.$ref === 'string' && node.$ref.startsWith(prefix)) {
    const name = decodeName(node.$ref.slice(prefix.length))
    if (stack.includes(name))
      fail(`recursive schema "${name}" cannot be expressed in OpenAPI 3.0 without components; pass libraryOptions.components or use draft-07/draft-2020-12`)
    return inline(structuredClone(defs[name]!), defs, [...stack, name])
  }
  return mapChildren(node, child => inline(child, defs, stack))
}

const computedDefault = '\u0000typebox-standard-schema:computed-default'

function dropComputedDefaults(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(dropComputedDefaults)
    return
  }
  if (!isNode(value))
    return
  if (value.default === computedDefault)
    delete value.default
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'const' && key !== 'enum' && key !== 'examples' && key !== 'default')
      dropComputedDefaults(child)
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────
// Every call builds a fresh object: consumers (the AI SDK among them) mutate
// what they get back, so nothing here may be cached or shared.
export function emitJsonSchema(schema: object, io: JsonSchemaIo, options: JsonSchemaOptions): Record<string, unknown> {
  const target: unknown = options?.target
  if (typeof target !== 'string' || !(supported as readonly string[]).includes(target))
    fail(`unsupported JSON Schema target ${JSON.stringify(target)} (supported: ${supported.join(', ')})`)
  const library = options.libraryOptions ?? {}
  const keepIds = library.keepIds === true
  const components = isNode(library.components) ? library.components : undefined

  // None of typebox's markers or this package's own bookkeeping is enumerable,
  // so a JSON round trip is a complete, plain, independent copy. A function
  // default (computed on each validation) has no JSON form: it stays as a
  // placeholder so its property still counts as defaulted, and is dropped below.
  let plain: unknown
  try {
    plain = JSON.parse(JSON.stringify(schema, (key, value) => key === 'default' && typeof value === 'function' ? computedDefault : value))
  }
  catch (error) {
    fail(`schema is not JSON-serializable (${(error as Error).message})`)
  }
  if (!isNode(plain))
    fail('only object schemas can be converted')

  delete plain.$schema // a foreign draft header (adopted schemas) is replaced below
  const hoisted = hoist(plain, target, keepIds)
  let root = transform(hoisted.node, io, target)
  const defs = Object.fromEntries(Object.entries(hoisted.defs).map(([name, def]) => [name, transform(def, io, target)]))

  // A root that is only a ref (Type.Cyclic) gets the definition inlined, so the
  // root states its own type; the definition stays for the recursive refs.
  const prefix = refPrefix[target]!
  if (library.inlineRoot !== false && typeof root.$ref === 'string' && root.$ref.startsWith(prefix) && Object.keys(root).length === 1) {
    const def = defs[decodeName(root.$ref.slice(prefix.length))]
    if (def)
      root = structuredClone(def)
  }

  dropComputedDefaults(root)
  Object.values(defs).forEach(dropComputedDefaults)

  if (target === 'openapi-3.0') {
    if (!components)
      return inline(root, defs, [])
    const schemas = isNode(components.schemas) ? components.schemas : (components.schemas = {}) as Node
    for (const [name, def] of Object.entries(defs)) {
      if (name in schemas && !same(schemas[name], def))
        fail(`components.schemas.${name} already holds a different schema`)
      schemas[name] = def
    }
    return root
  }

  const result: Node = { $schema: headers[target], ...root }
  if (Object.keys(defs).length)
    result[target === 'draft-07' ? 'definitions' : '$defs'] = defs
  return result
}
