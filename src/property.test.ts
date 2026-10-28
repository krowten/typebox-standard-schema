import type { Flag } from '../test/fuzz/model'
import type { TSchema, WithStandard } from './index'
import { describe, expect, test } from 'bun:test'
import { jsonSchemaProblems } from '../test/fuzz/json-schema'
import { build, expected, generate, random, value } from '../test/fuzz/model'
import { parse, Type, validate, Value } from './index'

// Property-based checks over random schemas (test/fuzz/model.ts, strict
// mode: shapes whose expected results are unambiguous). For every schema S
// and a value valid against it, each of Type.Read(S), Type.Write(S),
// Type.Read(Type.Write(S)) and S itself must
//
//   - accept the value (the full schema does),
//   - drop every field marked with the flag its mode cuts, wherever the value
//     puts it, and keep every other field the value has, unchanged,
//   - hand back a result its own schema accepts,
//   - answer the same through validate(), parse() and ~standard.validate,
//   - have a ~standard.jsonSchema.output (draft-2020-12) that is plain JSON,
//     compiles, and accepts the validated result.
//
// Deterministic: a fixed list of seeds, so a failure names the seed that
// reproduces it. `bun run test:fuzz` runs the same properties (and more shapes)
// from a fresh random seed every time.

const seeds = Array.from({ length: 300 }, (_, i) => i + 1)

describe('random schemas: projections cut exactly the marked fields', () => {
  test.each(seeds)('seed %i', (seed) => {
    const next = random(seed)
    const model = generate(next)
    const full = build(model)
    const input = value(model, next)
    // Required fields with a default may be absent: Default fills them in.
    expect(Value.Check(full, Value.Default(full, structuredClone(input)))).toBe(true)

    // [mode, schema validated, schema its result must satisfy, flags cut] —
    // a full schema hands back its write shape.
    const modes: [string, TSchema, TSchema, Flag[]][] = [
      ['read', Type.Read(full), Type.Read(full), ['writeOnly']],
      ['write', Type.Write(full), Type.Write(full), ['readOnly']],
      ['full', full, Type.Write(full), ['readOnly']],
      ['read of write', Type.Read(Type.Write(full)), Type.Read(Type.Write(full)), ['readOnly', 'writeOnly']],
    ]
    for (const [mode, schema, shape, cut] of modes) {
      const result = validate(schema, input)
      if (!result.success)
        throw new Error(`seed ${seed}, ${mode}: rejected ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`)
      expect([mode, result.data]).toEqual([mode, expected(model, input, cut)])
      expect([mode, Value.Check(shape, result.data)]).toEqual([mode, true])
      expect(parse(schema, input)).toEqual(result.data)
      expect((schema as WithStandard<TSchema>)['~standard'].validate(input)).toEqual({ value: result.data })
      expect([mode, jsonSchemaProblems(schema, result.data)]).toEqual([mode, []])
    }
  })
})
