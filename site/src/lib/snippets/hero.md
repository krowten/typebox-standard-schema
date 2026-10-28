```ts
import { Type, validate } from 'typebox-standard-schema'

const User = Type.Object({
  id: Type.Readonly(Type.String()),
  email: Type.String({ format: 'email' }),
  password: Type.Writeonly(Type.String({ minLength: 8 })),
})

const CreateUser = Type.Write(User) // { email, password }
const PublicUser = Type.Read(User) // { id, email }

// validate the input, or hand `User` to any Standard Schema consumer
const result = validate(User, { email: 'a@b.c', password: 'secret123' })
```
