// Standard Schema v1 surface (https://standardschema.dev) plus the Standard
// JSON Schema half (https://standardschema.dev/json-schema). Only the shape we
// attach to schemas lives here — the runtime implementation is in validate.ts
// (validation) and json-schema.ts (conversion).

import type { Static, TSchema } from 'typebox'
import type { JsonSchemaOptions } from './json-schema'
import type { ValidationIssue } from './validate'

// `types` is optional per the spec and never read at runtime — it exists so
// consumers (tRPC, Hono, TanStack Form, ...) can infer via
// StandardSchemaV1.InferInput/InferOutput. The pipeline coerces and applies
// defaults but never transforms shapes, so input and output are the same type.
//
// An interface, not a `type` (the one exception besides augment.ts): the
// augmentation instantiates this with a self-referential `this` argument, and
// only interfaces defer member evaluation — an eager alias sends every
// conditional over a schema type into itself (TS2589 across the project).
/* eslint-disable-next-line ts/consistent-type-definitions */
export interface StandardProps<Output = unknown> {
  readonly version: 1
  readonly vendor: string
  readonly types?: {
    readonly input: Output
    readonly output: Output
  }
  readonly validate: (value: unknown) =>
    | { readonly value: Output }
    | { readonly issues: readonly ValidationIssue[] }
  // StandardJSONSchemaV1: each call returns a fresh plain object, safe for the
  // caller to mutate. Both describe the validation target (a full schema is its
  // write projection); they differ only in how defaulted properties are
  // treated.
  readonly jsonSchema: {
    readonly input: (options: JsonSchemaOptions) => Record<string, unknown>
    readonly output: (options: JsonSchemaOptions) => Record<string, unknown>
  }
}

// For schemas NOT built via our `Type` (e.g. drizzle-typebox output, typed
// against @sinclair/typebox 0.34 — a different package, unreached by the
// module augmentation in augment.ts). Used by `adopt()`. `Static<T>` (our own
// typebox 1.x re-export) is applied directly to the foreign `T`: verified
// against a real @sinclair/typebox 0.34 schema from drizzle-typebox, it
// infers the actual table shape rather than collapsing to `any`/`unknown` —
// 0.34's schemas are structurally plain JSON Schema underneath, which is
// exactly what 1.x's own Static dispatches on. There is no polymorphic
// `this` here the way augment.ts uses one: `adopt` has its own type
// parameter `T`, so ordinary generic instantiation already gives the right
// answer per call site.
export type WithStandard<T extends TSchema> = T & {
  readonly '~standard': StandardProps<Static<T>>
}
