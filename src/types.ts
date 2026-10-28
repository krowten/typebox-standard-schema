// Type-level companions to the runtime utilities in type.ts.

import type { TArray, TDependent, TIntersect, TObject, TOptional, TProperties, TRecord, TRest, TSchema, TTuple, TUnion } from 'typebox'

// ─── Readonly / Writeonly marks ──────────────────────────────────────────────
// TypeBox erases schema options from the type level, so a plain
// `Type.String({ readOnly: true })` is just TString and mapped types can't see
// the flag. Type.Readonly/Type.Writeonly (runtime, in type.ts) set the JSON
// Schema keyword AND brand the type so TRead/TWrite can filter properties
// statically. Our Type.Readonly REPLACES TypeBox's built-in (which only sets
// the TS `readonly` modifier via '~readonly' and never reaches the JSON output).

export type TReadonly<T extends TSchema> = T & { readOnly: true }
export type TWriteonly<T extends TSchema> = T & { writeOnly: true }

// ─── TRead / TWrite (type-level projections) ─────────────────────────────────
// Schema-type transforms mirroring the runtime projections:
//   TWrite — drops Readonly-branded properties (input/validation shape),
//   TRead  — drops Writeonly-branded properties (output/response shape).
// Recurse through objects, tuples, records, arrays, unions, intersections,
// Type.Dependent branches and Optional wrappers — schemas compose by value, so the whole tree is visible
// to the type system. Type.Cyclic passes through unprojected at the type
// level (the runtime projection still handles it correctly): typebox's own
// recursive Static inference for TCyclic threads Stack/Context/This
// parameters through every step to keep the recursion well-founded, and
// distributing TProject over $defs would need to reproduce that machinery
// rather than just wrap it — a marked field inside a cyclic definition keeps
// its static presence even though the runtime cuts it. Test coverage for the
// non-Cyclic branches below is what actually protects the common case: a
// marked field on any of them now fails to compile if left in the static
// type, not just silently passes through.

type Flag = 'readOnly' | 'writeOnly'

type TProjectProps<P extends TProperties, F extends Flag> = {
  [K in keyof P as P[K] extends Record<F, true> ? never : K]: TProjectProp<P[K], F>
}
type TProjectProp<V extends TSchema, F extends Flag>
  = V extends TOptional<infer S extends TSchema> ? TOptional<TProject<S, F>> : TProject<V, F>
// Tuples are checked before arrays: their members live in an items array, which
// would otherwise be inferred as a single item schema. Members go through
// TProjectProp so an Optional one stays optional, and TRest is unwrapped so a
// rest element is projected like the runtime projects it.
// Unions/intersections are checked before Object: a TUnion/TIntersect is
// itself just `{ anyOf/allOf: TSchema[] }` at the type level and doesn't
// extend TObject, so ordering only matters for the mutual distinctness of
// these branches from each other, which their distinct member keys
// (anyOf vs allOf) already guarantee.
// Type.Dependent: the runtime projects then/else and leaves `if` alone (it
// selects the branch), but validation still cuts a field marked in `if` from
// the result — and Static of a Dependent folds `if` into the `then` shape. So
// `if` is projected here too.
type TProject<T extends TSchema, F extends Flag>
  = T extends TDependent<infer If extends TSchema, infer Then extends TSchema, infer Else extends TSchema>
    ? TDependent<TProject<If, F>, TProject<Then, F>, TProject<Else, F>>
    : T extends TUnion<infer Types extends TSchema[]>
      ? TUnion<{ [K in keyof Types]: TProject<Types[K], F> }>
      : T extends TIntersect<infer Types extends TSchema[]>
        ? TIntersect<{ [K in keyof Types]: TProjectMember<Types[K], F, TCutKeys<Types, F>> }>
        : T extends TObject<infer P extends TProperties>
          ? TObject<TProjectProps<P, F>>
          : T extends TTuple<infer Types extends TSchema[]>
            ? TTuple<{ [K in keyof Types]: TProjectProp<Types[K], F> }>
            : T extends TRest<infer S extends TSchema>
              ? TRest<TProject<S, F>>
              : T extends TRecord<infer K extends string, infer V extends TSchema>
                ? TRecord<K, TProject<V, F>>
                : T extends TArray<infer I extends TSchema>
                  ? TArray<TProject<I, F>>
                  : T

// Intersection members describe one value: a key one member marks is cut
// from all of them at runtime, so it leaves every member's static shape too.
type TCutKeys<Types extends TSchema[], F extends Flag> = {
  [I in keyof Types]: Types[I] extends TObject<infer P extends TProperties>
    ? { [K in keyof P]: P[K] extends Record<F, true> ? K : never }[keyof P]
    : never
}[number]
type TProjectMember<T extends TSchema, F extends Flag, Cut extends PropertyKey>
  = [Cut] extends [never]
    ? TProject<T, F>
    : T extends TObject<infer P extends TProperties>
      ? TObject<Omit<TProjectProps<P, F>, Cut>>
      : TProject<T, F>

// The phantom twin of the runtime mode tag: it marks a schema as "already a
// projection" so TValidated can tell one from a full schema. Type-level only —
// nothing is written to the schema object, so the JSON output is untouched.
type TProjection = { readonly '~projection': true }

// A reshaping factory (Partial/Required/Pick/Omit) applied to a projection
// returns that same projection, reshaped — the runtime carries the mode tag
// across (preserveProjection), and this carries the brand.
export type TReshaped<Source extends TSchema, Result extends TSchema> = Source extends TProjection ? Result & TProjection : Result

export type TWrite<T extends TSchema> = TProject<T, 'readOnly'> & TProjection
export type TRead<T extends TSchema> = TProject<T, 'writeOnly'> & TProjection

// What validate() and ~standard.validate() actually check, mirroring
// targetOf(): a projection validates as itself, any other schema against its
// write projection — inputs are the common case, and the readOnly fields it
// would strip are gone from the result.
export type TValidated<T extends TSchema> = T extends TProjection ? T : TWrite<T>
