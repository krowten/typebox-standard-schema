# API reference

Everything ships from the single entry point, `typebox-standard-schema`.

| Export | Description |
| --- | --- |
| `Type` | The schema builder — all TypeBox factories (`Object`, `String`, `Union`, `Cyclic`, ...), every result carrying `~standard`, plus the methods below. |
| `Type.Readonly(schema)` | Marks a field as output-only (`readOnly: true`) — kept by `Type.Read`, cut by `Type.Write`. Replaces TypeBox's own type-level-only `Readonly`. |
| `Type.Writeonly(schema)` | Marks a field as input-only (`writeOnly: true`) — kept by `Type.Write`, cut by `Type.Read`. |
| `Type.Read(schema, options?)` | Output projection: drops `writeOnly` fields (runtime + static). Memoized per schema; with `options` returns a standalone named clone. |
| `Type.Write(schema, options?)` | Input projection: drops `readOnly` fields. Same memoization and options. |
| `Type.Partial(schema, options?)` | TypeBox's `Partial` + strips property defaults for PATCH-safe partial updates. |
| `validate(schema, data)` | Runs the pipeline above; returns `{ success: true, data }` or `{ success: false, errors }`. `data` is typed as the shape actually checked — see `TValidated`. |
| `parse(schema, data)` | Assert-style: returns the validated data or throws a `ValidationError`. |
| `isValidationError(e)` | Type guard for the error `parse` throws (`e.issues` carries the details). |
| `adopt(schema)` | Attaches `~standard` to a schema built outside this package. |
| `Format` | The format registry — `Format.Set('name', fn)` to register custom string formats; a change recompiles schemas on their next validation. |
| `Value` | Re-export of `typebox/value` for ad-hoc operations (`Value.Check`, `Value.Clone`, ...). |
| `Static<T>` | Static type inference for a schema (re-exported from typebox). |
| `ValidationResult<T>`, `ValidationIssue`, `ValidationError` | The result union, the issue shape, and the error `parse` throws. |
| `TRead<T>`, `TWrite<T>`, `TReadonly<T>`, `TWriteonly<T>` | Type-level companions of the projections and field marks. |
| `TValidated<T>` | The shape `validate` checks: `TWrite<T>` for a full schema, `T` itself when it already is a projection. |
| `ProjectionOptions` | Options accepted by `Type.Read`/`Type.Write` (`suffix` + any schema options). |
| `schema['~standard'].jsonSchema` | `input(options)` / `output(options)` — [Standard JSON Schema](/json-schema): a fresh JSON Schema of what the schema validates. |
| `JsonSchemaTarget`, `JsonSchemaOptions` | `'draft-2020-12' \| 'draft-07' \| 'openapi-3.0'`, and `{ target, libraryOptions? }` (`keepIds`, `inlineRoot`, `components`). |
| `StandardProps`, `WithStandard<T>` | The `~standard` interface shape and the type `adopt` returns. |
| `TSchema`, `TObject`, `TArray`, `TOptional`, `TProperties`, `TSchemaOptions` | Common TypeBox types, re-exported for convenience. |

