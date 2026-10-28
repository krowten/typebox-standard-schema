# Custom formats and types

Register your own formats through the exported `Format` registry. Registration order doesn't matter: a change to the registry makes every schema recompile on its next validation, so a format registered (or replaced) after a schema has already validated still applies. Until a format is registered it is ignored, per JSON Schema semantics:

```ts
import { Format, Type, validate } from 'typebox-standard-schema'

Format.Set('hex-color', value => /^#[0-9a-f]{6}$/i.test(value))

const Theme = Type.Object({ accent: Type.String({ format: 'hex-color' }) })
validate(Theme, { accent: 'red' })
// → { success: false, errors: [{ keyword: 'format', params: { format: 'hex-color' }, ... }] }
```

For custom schema nodes use `Type.Unsafe`: hand it any JSON Schema the engine understands and pin the static type via the generic — the result carries `~standard` and composes like every other schema:

```ts
const Celsius = Type.Unsafe<number>({ type: 'number', minimum: -273.15 })

const Weather = Type.Object({ temp: Celsius })
type Weather = Static<typeof Weather> // { temp: number }
```
