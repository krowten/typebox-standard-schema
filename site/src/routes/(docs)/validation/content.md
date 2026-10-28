# Validation

`validate(schema, data)` and `schema['~standard'].validate(data)` share one pipeline.

## Pipeline

1. **Clone** — the input is cloned first; your original value is never mutated. Payloads `structuredClone` refuses (functions, symbols, class instances with methods) fall back to a structural copy — validation never throws on weird input, it reports it.
2. **Default** — missing values — absent keys and `undefined` — with a `default` annotation are filled in before anything is converted (except through `Type.Partial` — see [Projections](/projections#partial-updates)).
3. **Convert** — form-friendly coercion, so values read from `FormData`, a query string or `process.env` validate without manual parsing. Pass a plain object, not the `FormData` instance itself — e.g. `Object.fromEntries(formData)`, collecting repeated keys and files yourself where your form has them. Only strings are converted, by [Ajv's `coerceTypes`](https://ajv.js.org/coercion.html) rules, and only when the result means the same thing:

   | To | From |
   | --- | --- |
   | number, integer | a numeric string: `'42'`, `' 4.5 '`, `'1e3'` |
   | boolean | `'true'`, `'false'` |
   | null | `''` |
   | array | a lone string, as a one-item array (a form field sent once) |

   Any other string fails validation: `''` and `'abc'` are not numbers, `'1.5'` is not an integer, `'Infinity'` is not a JSON number, `'1'` and `'yes'` are not booleans. Values that aren't strings are never converted, so in a JSON body `null`, `true` or `123` where the schema wants something else is reported, not turned into `0`, `1` or `'123'`. A value that already passes is left alone: `'5'` stays a string in `Type.Union([Type.Number(), Type.String()])`. `undefined` means "no value": it has already received its default in the previous step or is reported as missing.
4. **Check** — the JIT-compiled validator judges the data *as it arrived*: every constraint, `if`/`not`/`oneOf` included, sees what the full schema would see. The one allowance: a field the projection cut may be missing — it is still checked against its own schema when present, and a `Type.Read` of an `additionalProperties: false` schema still accepts a full database row. A client-supplied `readOnly` field of the wrong type is therefore an error rather than something quietly dropped (unless Convert can turn it into the right type: `id: '7'` for an integer id is converted, then stripped). Compilation happens once per schema (cached by identity), on first use — so treat a schema as immutable once it has validated anything: editing it in place afterwards (`schema.minimum = 10`) is not picked up. Build a new schema instead.
5. **Strip** — the fields a projection cut are deleted from the result: a `Type.Read` result can't carry a `writeOnly` secret, a `Type.Write` result can't carry a client-supplied `readOnly` id. This is what makes a projection an actual boundary rather than a description. It follows the data through nested objects, arrays, tuples, records, unions, intersections, `Type.Dependent` branches (a field marked in `if` included), `Type.Cyclic` definitions and `$ref`s (JSON pointers, `$id`, `$anchor`). A field cut by anything that applies to the value unconditionally — an intersection member, the `Type.Dependent` branch taken — is always removed. A field cut only in some union variant is removed unless another variant the value actually matches declares it: a variant that merely tolerates extra keys never echoes back another variant's secret. Nothing else is touched: an undeclared key the schema allows stays.

   Marks count where they describe a field: on a property schema, in an object, intersection member, union variant or `Type.Dependent` branch (a field marked in `if` included). A mark on a `Type.Cyclic` definition, an array item or a record value describes the value there, not a field, and cuts nothing. When a `Type.Dependent`'s `if` reads a field the projection cuts, the result is the validated data minus that field; checked against the projection's own `if` again, it may fall into the other branch. A `$ref` that can't be resolved while there are fields to cut fails the validation (`$ref` issue) rather than guessing.

## Errors

Error reporting follows TypeBox's, issue for issue — except in schemas that recurse (`Type.Cyclic`) and branch (unions), where collecting every error of every branch would take exponential time: there a failed union reports the issues of the branch the value meant (a tagged union, told apart by a literal discriminator) or a single `anyOf` issue.

Two `Type.Cyclic` with the same definition name in one schema collide in TypeBox's own reference resolution — name definitions uniquely.

Data that can't be validated at all — cyclic data where a union or recursive schema would follow it, nesting deeper than the stack allows, a getter that throws — comes back as an issue (`circular`, `depth`, `unreadable`), never as an exception.

## Targets and parse

A full schema validates against its **write projection** — inputs are the common case. A projection obtained from `Type.Read`/`Type.Write` validates as itself. `Type.Partial`, `Type.Required`, `Type.Pick` and `Type.Omit` of a projection are still that projection. A schema built around one — `Type.Array(Type.Read(User))`, `Type.Object({ user: Type.Read(User) })`, `Type.Intersect([Type.Read(A), Type.Read(B)])` and what `Type.Evaluate`/`Type.Interface` make of it — is a new full schema and validates as its write projection, the fields the inner projection cut still cut; to validate the whole thing as a read shape, project the whole thing: `Type.Read(Type.Array(User))`. The static type follows: `validate(User, ...)` returns the write shape (the `readOnly` fields it strips are gone from the type too), `validate(Type.Read(User), ...)` returns the read shape.

When you want the data or an exception rather than a result object, use `parse` — same pipeline, same target rules:

```ts
import { isValidationError, parse } from 'typebox-standard-schema'

try {
  const user = parse(User, await request.json()) // typed as the write shape
}
catch (error) {
  if (isValidationError(error))
    console.log(error.issues) // same ValidationIssue[] as validate()
}
```

### Issue shape

Errors come back as flat, form-ready issues:

```ts
type ValidationIssue = {
  message: string // English text from typebox
  keyword: string // ajv-style: 'required', 'format', 'minLength', ...
  params: Record<string, unknown> // e.g. { format: 'email' } — enough for i18n mapping
  path: (string | number)[] // ['info', 'height'] — field path segments
}
```

A missing-properties error is fanned out into one issue per field (with `path` pointing at each), so form libraries can attach every message to its input.

### Formats

Formats (`email`, `uuid`, `date-time`, ...) are built into typebox 1.x and enforced by default — no registration needed.

