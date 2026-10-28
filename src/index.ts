// typebox-standard-schema — Standard Schema v1 for typebox 1.x with
// readOnly/writeOnly schema projections. Schemas compose by value and stay
// self-contained; recursive types use Type.Cyclic.
//
// The exported surface is curated on purpose — raw TypeBox constructors are
// NOT re-exported: schemas are built exclusively via our `Type`, so every one
// of them gets ~standard out of the box. Consumers never import 'typebox'
// directly.

import './augment'

export { Format } from './format'
export type { JsonSchemaOptions, JsonSchemaTarget } from './json-schema'
export type { StandardProps, WithStandard } from './standard'
export type { ProjectionOptions } from './type'
export { adopt, Type } from './type'

export type { TRead, TReadonly, TValidated, TWrite, TWriteonly } from './types'
export type { ValidationError, ValidationIssue, ValidationResult } from './validate'
export { isValidationError, parse, validate } from './validate'
// Curated re-exports: the types consumers actually need, plus Value for ad-hoc
// checks. Formats (email/uuid/date-time/...) are built into typebox 1.x and
// enforced by default — no manual registration needed anymore; Format is the
// registry for adding custom ones (Format.Set('name', fn) — compiled
// validators are rebuilt after a change, so registration order doesn't
// matter; see format.ts).
export type { Static, TArray, TObject, TOptional, TProperties, TSchema, TSchemaOptions } from 'typebox'
export { default as Value } from 'typebox/value'
