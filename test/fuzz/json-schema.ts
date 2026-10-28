// The Standard JSON Schema half of the fuzzer, shared by test/fuzz/run.ts and
// src/property.test.ts: what `~standard.jsonSchema` must hold for any schema
// and any data its validator accepted.

import type { TSchema } from '../../src/index'
import Ajv2020 from 'ajv/dist/2020'

const ajv = new Ajv2020({ strict: false })

type Standard = { jsonSchema: Record<'input' | 'output', (options: { target: string }) => unknown> }

function tildeKeys(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null)
    return []
  return Reflect.ownKeys(value).flatMap((key) => {
    const here = `${path}.${String(key)}`
    const nested = tildeKeys((value as Record<string | symbol, unknown>)[key], here)
    return typeof key === 'symbol' || key.startsWith('~') ? [here, ...nested] : nested
  })
}

// Empty when every property holds:
//
//   - input and output (draft-2020-12) are plain JSON: a JSON round trip
//     changes nothing, and no key starts with `~` (no leaked bookkeeping)
//   - both are valid schemas Ajv compiles
//   - output accepts `data`, the value validate() handed back
//
// `data` is skipped when undefined (nothing was accepted).
export function jsonSchemaProblems(schema: TSchema, data?: unknown): string[] {
  const problems: string[] = []
  const standard = (schema as unknown as { '~standard': Standard })['~standard'].jsonSchema
  for (const io of ['input', 'output'] as const) {
    const emitted = standard[io]({ target: 'draft-2020-12' })
    if (JSON.stringify(JSON.parse(JSON.stringify(emitted))) !== JSON.stringify(emitted))
      problems.push(`${io}: not JSON-stable`)
    for (const key of tildeKeys(emitted))
      problems.push(`${io}: leaked key ${key}`)
    try {
      const check = ajv.compile(emitted as object)
      if (io === 'output' && data !== undefined && !check(data))
        problems.push(`output: rejects the validated data (${ajv.errorsText(check.errors)})`)
      ajv.removeSchema(emitted as object)
    }
    catch (error) {
      problems.push(`${io}: does not compile (${(error as Error).message})`)
    }
  }
  return problems
}
