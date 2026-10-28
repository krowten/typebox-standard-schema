# Adopting external schemas

Schemas produced by other TypeBox-based generators — e.g. [`drizzle-typebox`](https://orm.drizzle.team/docs/typebox), which derives TypeBox schemas from your Drizzle ORM tables — are plain JSON Schema objects, but they are not created through this package's `Type`, so they don't get `~standard` automatically. Pass them through `adopt()` to attach it:

```ts
import { createInsertSchema } from 'drizzle-typebox'
import { adopt } from 'typebox-standard-schema'

const InsertUser = adopt(createInsertSchema(usersTable))
InsertUser['~standard'].validate(data) // now a Standard Schema
```
