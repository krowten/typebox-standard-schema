// Property-based fuzzer: random schemas, random valid data, every projection.
//
//   bun run test:fuzz                        2000 cases from a random seed
//   bun run test:fuzz --count 20000          more cases
//   bun run test:fuzz --seed 123456          replay a run (printed at the start)
//   bun run test:fuzz --mode strict|broad    one generator only (default: both)
//   bun run test:fuzz --budget 200           warm-call time limit in ms
//
// Each case validates one generated value against S, Type.Read(S),
// Type.Write(S), Type.Read(Type.Write(S)), Type.Partial(Type.Read(S)) and
// Type.Object({ x: Type.Read(S) }), and checks:
//
//   accepts   — data the full schema accepts is never rejected
//   exact     — (strict) the result is the input minus exactly the marked
//               fields, plus defaults: no leak, nothing else lost or added
//   own       — the result satisfies the projection's own schema
//   stable    — validating the result again changes nothing
//   parity    — validate(), parse() and ~standard.validate agree
//   json      — ~standard.jsonSchema (draft-2020-12): input and output are
//               plain JSON (a JSON round trip changes nothing, no `~` keys),
//               both compile in Ajv, and output accepts the data validate()
//               returned. Input is deliberately not checked against the
//               generated value: validate() coerces and accepts fields the
//               projection cuts, so only output has an exact oracle.
//   fast      — a warm call stays under the budget
//   no-throw  — nothing throws
//
// `own`, `stable` and `json` are skipped where a Type.Dependent is involved: when
// its `if` reads a field the projection cuts, the result may land in the
// other branch — documented, and not a leak.
//
// A failure is shrunk (keys and array items removed while it still fails
// the same way) and printed as a runnable snippet. Exit code 1 if anything
// failed, so it can run in a loop or a scheduled CI job.

import type { TSchema } from '../../src/index'
import type { Flag, Mode, Model } from './model'
import process from 'node:process'
import { parse, Type, validate, Value } from '../../src/index'
import { jsonSchemaProblems } from './json-schema'
import { build, code, expected, generate, hasKind, random, value } from './model'

type Variant = {
  name: string
  schema: (full: TSchema) => TSchema
  // The schema a result must satisfy: the projection itself, or for a full
  // schema (validated as its write projection) Type.Write of it.
  shape: (full: TSchema, validated: TSchema) => TSchema
  source: (full: string) => string
  wrap?: (input: unknown) => unknown
  // Strict oracle: flags cut, and how the expected result is wrapped.
  cut?: Flag[]
}

const variants: Variant[] = [
  { name: 'read', schema: s => Type.Read(s), shape: (_, v) => v, source: s => `Type.Read(${s})`, cut: ['writeOnly'] },
  { name: 'write', schema: s => Type.Write(s), shape: (_, v) => v, source: s => `Type.Write(${s})`, cut: ['readOnly'] },
  { name: 'full', schema: s => s, shape: s => Type.Write(s), source: s => s, cut: ['readOnly'] },
  { name: 'read of write', schema: s => Type.Read(Type.Write(s)), shape: (_, v) => v, source: s => `Type.Read(Type.Write(${s}))`, cut: ['readOnly', 'writeOnly'] },
  { name: 'partial read', schema: s => Type.Partial(Type.Read(s)), shape: (_, v) => v, source: s => `Type.Partial(Type.Read(${s}))` },
  {
    name: 'nested read',
    // A schema built around a projection is a full schema again: validated
    // as its write projection, which cuts readOnly fields too.
    schema: s => Type.Object({ x: Type.Read(s) }),
    shape: (_, v) => Type.Write(v),
    source: s => `Type.Object({ x: Type.Read(${s}) })`,
    wrap: input => ({ x: input }),
    cut: ['readOnly', 'writeOnly'],
  },
]

type Failure = { check: string, message: string, got?: unknown, want?: unknown }

// Deep equality where key order doesn't matter (an object's keys may come
// back in a different order once defaults are filled in).
function same(a: unknown, b: unknown): boolean {
  if (a === b)
    return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]))
}

function acceptsFull(full: TSchema, input: unknown): boolean {
  try {
    return Value.Check(full, Value.Default(full, structuredClone(input)))
  }
  catch {
    return false
  }
}

function runCase(model: Model, full: TSchema, variant: Variant, input: unknown, mode: Mode, budget: number): Failure[] {
  const fails: Failure[] = []
  const dependent = hasKind(model, 'dependent')
  const data = variant.wrap ? variant.wrap(input) : input
  let schema: TSchema
  try {
    schema = variant.schema(full)
  }
  catch (error) {
    return [{ check: 'no-throw', message: `building the schema threw: ${(error as Error).message}` }]
  }
  try {
    const result = validate(schema, data)
    const started = performance.now()
    validate(schema, data)
    const warm = performance.now() - started
    if (warm > budget)
      fails.push({ check: 'fast', message: `warm call took ${warm.toFixed(0)}ms (budget ${budget}ms)` })

    const standard = (schema as { '~standard': { validate: (value: unknown) => unknown } })['~standard'].validate(data)
    let parsed: unknown
    let thrown: { issues?: unknown } | undefined
    try {
      parsed = parse(schema, data)
    }
    catch (error) {
      thrown = error as { issues?: unknown }
    }
    if (result.success ? !same(standard, { value: result.data }) || !same(parsed, result.data) : !same(standard, { issues: result.errors }) || !same(thrown?.issues, result.errors))
      fails.push({ check: 'parity', message: 'validate(), parse() and ~standard.validate disagree' })

    if (result.success && !dependent) {
      // Defaults are not filled through nested Type.Cyclic, so there the
      // result is not held to the output's `required`; the rest still is.
      for (const problem of jsonSchemaProblems(schema, result.data))
        fails.push({ check: 'json', message: problem, got: result.data })
    }

    if (!acceptsFull(full, input))
      return fails
    if (!result.success) {
      fails.push({ check: 'accepts', message: 'rejected data the full schema accepts', got: result.errors })
      return fails
    }

    if (mode === 'strict' && variant.cut) {
      const want = expected(model, input, variant.cut)
      const wrapped = variant.wrap ? variant.wrap(want) : want
      if (!same(result.data, wrapped))
        fails.push({ check: 'exact', message: 'the result is not the input minus exactly the marked fields', got: result.data, want: wrapped })
    }
    if (!dependent) {
      if (!Value.Check(variant.shape(full, schema), result.data))
        fails.push({ check: 'own', message: 'the result fails the projection\'s own schema', got: result.data })
      const again = validate(schema, result.data)
      if (!again.success || !same(again.data, result.data))
        fails.push({ check: 'stable', message: 'validating the result again changed it', got: again.success ? again.data : again.errors, want: result.data })
    }
  }
  catch (error) {
    fails.push({ check: 'no-throw', message: `threw: ${(error as Error).message}` })
  }
  return fails
}

// Smaller inputs that still fail the same check: keys and array items
// removed one at a time, depth-first, until nothing more can go.
function shrink(input: unknown, failsSame: (input: unknown) => boolean): unknown {
  const candidates = (value: unknown): unknown[] => {
    const out: unknown[] = []
    if (Array.isArray(value)) {
      value.forEach((_, index) => out.push(value.filter((__, i) => i !== index)))
      value.forEach((item, index) => candidates(item).forEach(smaller => out.push(value.map((v, i) => (i === index ? smaller : v)))))
    }
    else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        const { [key]: _, ...rest } = record
        out.push(rest)
      }
      for (const key of Object.keys(record))
        candidates(record[key]).forEach(smaller => out.push({ ...record, [key]: smaller }))
    }
    return out
  }
  let current = input
  for (let round = 0; round < 200; round++) {
    const next = candidates(current).find(failsSame)
    if (next === undefined)
      return current
    current = next
  }
  return current
}

function args(): { count: number, seed: number, modes: Mode[], budget: number } {
  const argv = process.argv.slice(2)
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) : argv[index + 1]
  }
  const mode = option('mode')
  return {
    count: Number(option('count') ?? 2000),
    seed: Number(option('seed') ?? crypto.getRandomValues(new Uint32Array(1))[0]),
    modes: mode === 'strict' || mode === 'broad' ? [mode] : ['strict', 'broad'],
    budget: Number(option('budget') ?? 200),
  }
}

if (import.meta.main) {
  const { count, seed, modes, budget } = args()
  console.log(`fuzz: ${count} cases, seed ${seed}, modes ${modes.join('+')} — replay with --seed ${seed}${modes.length === 1 ? ` --mode ${modes[0]}` : ''}`)
  const started = performance.now()
  const seen = new Map<string, number>()
  let runs = 0
  for (let i = 0; i < count; i++) {
    const caseSeed = (seed + i) >>> 0
    const mode = modes[i % modes.length]!
    const next = random(caseSeed)
    const model = generate(next, mode)
    const input = value(model, next)
    let full: TSchema
    try {
      full = build(model)
    }
    catch (error) {
      console.log(`\nFAIL no-throw — building case ${caseSeed} threw: ${(error as Error).message}\n  schema: ${code(model)}`)
      seen.set('build|no-throw', (seen.get('build|no-throw') ?? 0) + 1)
      continue
    }
    for (const variant of variants) {
      runs++
      const fails = runCase(model, full, variant, input, mode, budget)
      for (const fail of fails) {
        const signature = `${variant.name}|${fail.check}`
        const times = (seen.get(signature) ?? 0) + 1
        seen.set(signature, times)
        if (times > 1)
          continue
        const small = fail.check === 'fast'
          ? input
          : shrink(input, candidate => runCase(model, full, variant, candidate, mode, Number.POSITIVE_INFINITY).some(other => other.check === fail.check))
        const final = runCase(model, full, variant, small, mode, fail.check === 'fast' ? budget : Number.POSITIVE_INFINITY).find(other => other.check === fail.check) ?? fail
        const schemaSource = variant.source('S')
        const wrapped = variant.wrap ? variant.wrap(small) : small
        console.log([
          ``,
          `FAIL ${fail.check} — ${variant.name}: ${final.message}`,
          `  case:   seed ${caseSeed}, ${mode}`,
          `  input:  ${JSON.stringify(wrapped)}`,
          ...(final.got === undefined ? [] : [`  got:    ${JSON.stringify(final.got)}`]),
          ...(final.want === undefined ? [] : [`  want:   ${JSON.stringify(final.want)}`]),
          `  repro (from the repository root):`,
          `    import { Type, validate } from './src/index'`,
          `    const S = ${code(model)}`,
          `    console.log(JSON.stringify(validate(${schemaSource}, ${JSON.stringify(wrapped)})))`,
        ].join('\n'))
      }
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  const total = [...seen.values()].reduce((sum, times) => sum + times, 0)
  console.log(`\n${count} cases, ${runs} runs in ${seconds}s — ${total === 0 ? 'no failures' : `${total} failures`}`)
  for (const [signature, times] of seen) console.log(`  ${times}x ${signature.replace('|', ': ')}`)
  process.exit(total === 0 ? 0 : 1)
}
