// Error collection for schemas where typebox's own would explode. typebox
// reports a failed union by collecting every error of every branch — and for
// an object it collects every property's errors, not just the first — so a
// recursive union handed a deep invalid value walks every combination of
// branches down to the bottom: a couple of hundred bytes, seconds of work.
//
// This walk only descends where the value actually fails. A node that passes
// its compiled Check contributes nothing; a failing object, array, tuple or
// record gets typebox's errors for its own level alone (its children replaced
// by "anything" — so required, additionalProperties, length and the like are
// judged there), then the walk moves into the children that fail. A failing
// union reports the branch the value can only have meant, when the cheap
// filter leaves exactly one (a tagged union), and a single anyOf error
// otherwise. Each value is checked once per schema node on its way down.
//
// Used where the risk is: schemas that recurse (a Type.Cyclic) and branch
// (a union) — elsewhere typebox's own collection stands, error for error.

import type { TSchema } from 'typebox'
import type { Defs } from './coerce'
import OriginalType from 'typebox'
import Value from 'typebox/value'
import { check, isDictionary, isNode, kindOf, ruledOut, scopeOf } from './coerce'
import { cloneWith } from './projection'

export type SchemaError = {
  keyword: string
  instancePath: string
  params: Record<string, unknown>
  message: string
}

type Node = Record<string, unknown>

const shallows = new WeakMap<TSchema, TSchema>()

// The node with every child schema replaced by Unknown: its own keywords,
// nothing below.
function shallowOf(schema: TSchema): TSchema {
  let shallow = shallows.get(schema)
  if (shallow)
    return shallow
  const node = schema as Node
  const overrides: Record<string, unknown> = {}
  for (const key of ['properties', 'patternProperties'] as const) {
    if (isDictionary(node[key]))
      overrides[key] = Object.assign(Object.create(null), Object.fromEntries(Object.keys(node[key] as object).map(name => [name, OriginalType.Unknown()])))
  }
  for (const key of ['items', 'additionalItems', 'additionalProperties'] as const) {
    const child = node[key]
    if (Array.isArray(child))
      overrides[key] = child.map(() => OriginalType.Unknown())
    else if (isNode(child))
      overrides[key] = OriginalType.Unknown()
  }
  shallows.set(schema, shallow = cloneWith(schema, overrides))
  return shallow
}

function own(schema: TSchema, defs: Defs, value: unknown, path: string, out: SchemaError[]): void {
  for (const error of Value.Errors(defs as Record<string, TSchema>, schema, value) as unknown as SchemaError[])
    out.push({ ...error, instancePath: path + error.instancePath })
}

function collect(schema: TSchema, value: unknown, outer: Defs, path: string, out: SchemaError[]): void {
  if (!isNode(schema))
    return
  const defs = scopeOf(schema, outer)
  if (check(schema, defs, value))
    return
  const node = schema as Node
  const kind = kindOf(schema)
  // A Type.Cyclic or Type.Ref, or a plain { $ref } of an adopted schema.
  if (typeof node.$ref === 'string' && (kind === 'Cyclic' || kind === 'Ref' || kind === undefined)) {
    const target = defs[node.$ref]
    return target ? collect(target, value, defs, path, out) : own(schema, defs, value, path, out)
  }
  switch (kind) {
    case 'Union': {
      const candidates = ((node.anyOf as TSchema[]) ?? []).filter(branch => !ruledOut(branch, defs, value, true))
      if (candidates.length === 1)
        return collect(candidates[0]!, value, defs, path, out)
      out.push({ keyword: 'anyOf', instancePath: path, params: {}, message: 'must match a schema in anyOf' })
      return
    }
    case 'Intersect': {
      if ('unevaluatedProperties' in node)
        return own(schema, defs, value, path, out)
      for (const member of (node.allOf as TSchema[]) ?? []) collect(member, value, defs, path, out)
      return
    }
    case 'Object':
    case 'Record': {
      own(shallowOf(schema), defs, value, path, out)
      if (!isDictionary(value))
        return
      const properties = isDictionary(node.properties) ? node.properties as Record<string, TSchema> : {}
      const patterns = isDictionary(node.patternProperties)
        ? Object.entries(node.patternProperties as Record<string, TSchema>).map(([source, child]) => [new RegExp(source), child] as const)
        : []
      const additional = isNode(node.additionalProperties) ? node.additionalProperties as TSchema : undefined
      for (const key of Object.keys(value)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : patterns.find(([pattern]) => pattern.test(key))?.[1] ?? additional
        if (child)
          collect(child, value[key], defs, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, out)
      }
      return
    }
    case 'Array':
    case 'Tuple': {
      own(shallowOf(schema), defs, value, path, out)
      if (!Array.isArray(value))
        return
      const positional = Array.isArray(node.items) ? node.items as TSchema[] : []
      const rest = Array.isArray(node.items) ? node.additionalItems : node.items
      value.forEach((item, index) => {
        const child = positional[index] ?? (isNode(rest) ? rest as TSchema : undefined)
        if (child)
          collect(child, item, defs, `${path}/${index}`, out)
      })
      return
    }
    default:
      own(schema, defs, value, path, out)
  }
}

export function collectErrors(schema: TSchema, value: unknown): SchemaError[] {
  const out: SchemaError[] = []
  collect(schema, value, Object.create(null), '', out)
  return out
}
