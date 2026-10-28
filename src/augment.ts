// Augment every concrete schema-node interface (NOT the bare `TSchema` base,
// and NOT `TProperties`) so `Type.xxx()` results are typed as Standard Schema
// v1 compliant, with full generic parameters preserved. Two things this is NOT:
//
// 1. NOT `declare module { interface TSchema { '~standard': ... } }`. In 1.x
//    `TProperties` (the properties-bag type `Type.Object()` takes as its first
//    argument) itself extends `TSchema` — augmenting the bare base would force
//    every plain `{ foo: Type.String() }` properties object to carry
//    '~standard' too, a type error on every single schema declaration.
// 2. NOT a post-hoc mapped type over `typeof OriginalType` (`{ [K in keyof
//    typeof OriginalType]: ... }`). Each `Type.xxx` is a *generic* function
//    (`<Properties extends TProperties>(properties: Properties, ...) =>
//    TObject<Properties>`); extracting args/return via `infer` on an already-
//    generic function type collapses its type parameter to its constraint
//    (`TProperties`, the widest possible bag) — every schema would type as
//    "some object with arbitrary properties" instead of the actual fields
//    passed in. Declaration merging on the *interface* (TObject, TString, ...)
//    sidesteps this entirely: the merge applies to the interface's own
//    declared shape, so it's inherited by every generic instantiation exactly
//    as TypeScript inferred it at the call site.
//
// The property type is `TStandard<this>` — the polymorphic `this` type is the
// type-level twin of the runtime accessor in validate.ts: both resolve against
// the receiver the property is read from, so `Type.Read(User)['~standard']`
// carries the read shape while `User['~standard']` carries the write shape.
// Through `types` this is what Standard Schema consumers infer
// (StandardSchemaV1.InferInput/InferOutput) — without it they would see `any`.
//
// Interfaces (not `type`) are mandatory here: declaration merging is an
// interface-only mechanism in TypeScript. The generic parameters are unused in
// the merged bodies but must repeat the original declarations verbatim.
/* eslint-disable ts/consistent-type-definitions, unused-imports/no-unused-vars */

import type { Static, TEnumValue, TLiteralValue, TProperties, TSchema } from 'typebox'
import type { StandardProps } from './standard'
import type { TValidated } from './types'

// An interface extending StandardProps, not an alias: interfaces defer member
// evaluation, so the self-reference through `this` below stays lazy — an alias
// computing Static<...> eagerly makes every conditional over a schema type
// recurse into itself (TS2589 across the whole project).
interface TStandard<T extends TSchema> extends StandardProps<Static<TValidated<T>>> {}

declare module 'typebox' {
  interface TObject<Properties extends TProperties = TProperties> {
    readonly '~standard': TStandard<this>
  }
  interface TArray<Type extends TSchema = TSchema> {
    readonly '~standard': TStandard<this>
  }
  interface TUnion<Types extends TSchema[] = TSchema[]> {
    readonly '~standard': TStandard<this>
  }
  interface TIntersect<Types extends TSchema[] = TSchema[]> {
    readonly '~standard': TStandard<this>
  }
  interface TTuple<Types extends TSchema[] = TSchema[]> {
    readonly '~standard': TStandard<this>
  }
  interface TRecord<Key extends string = string, Value extends TSchema = TSchema> {
    readonly '~standard': TStandard<this>
  }
  interface TCyclic<Defs extends TProperties = TProperties, Ref extends string = string> {
    readonly '~standard': TStandard<this>
  }
  interface TDependent<If extends TSchema = TSchema, Then extends TSchema = TSchema, Else extends TSchema = TSchema> {
    readonly '~standard': TStandard<this>
  }
  interface TLiteral<Value extends TLiteralValue = TLiteralValue> {
    readonly '~standard': TStandard<this>
  }
  interface TEnum<Values extends TEnumValue[] = TEnumValue[]> {
    readonly '~standard': TStandard<this>
  }
  interface TTemplateLiteral<Pattern extends string = string> {
    readonly '~standard': TStandard<this>
  }
  interface TFunction<
    Parameters extends TSchema[] = TSchema[],
    ReturnType extends TSchema = TSchema,
  > {
    readonly '~standard': TStandard<this>
  }
  interface TConstructor<
    Parameters extends TSchema[] = TSchema[],
    InstanceType extends TSchema = TSchema,
  > {
    readonly '~standard': TStandard<this>
  }
  interface TUnsafe<Type = unknown> {
    readonly '~standard': TStandard<this>
  }
  interface TString {
    readonly '~standard': TStandard<this>
  }
  interface TNumber {
    readonly '~standard': TStandard<this>
  }
  interface TInteger {
    readonly '~standard': TStandard<this>
  }
  interface TBoolean {
    readonly '~standard': TStandard<this>
  }
  interface TBigInt {
    readonly '~standard': TStandard<this>
  }
  interface TSymbol {
    readonly '~standard': TStandard<this>
  }
  interface TNull {
    readonly '~standard': TStandard<this>
  }
  interface TUndefined {
    readonly '~standard': TStandard<this>
  }
  interface TVoid {
    readonly '~standard': TStandard<this>
  }
  interface TAny {
    readonly '~standard': TStandard<this>
  }
  interface TUnknown {
    readonly '~standard': TStandard<this>
  }
  interface TNever {
    readonly '~standard': TStandard<this>
  }
}
