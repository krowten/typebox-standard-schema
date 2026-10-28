// The format registry, as exported to consumers. typebox (since 1.3.31)
// bakes the registry into a validator when it compiles: a format registered —
// or replaced — after a schema first validated would never reach that
// schema's cached validator. Every change made through this Format bumps a
// revision, and the validator caches (compiledCache) start over when it
// moves, so registration order still doesn't matter.

import TypeboxFormat from 'typebox/format'

let revision = 0

function bumping<A extends unknown[], R>(change: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    const result = change(...args)
    revision++
    return result
  }
}

export const Format: typeof TypeboxFormat = {
  ...TypeboxFormat,
  Set: bumping(TypeboxFormat.Set),
  Clear: bumping(TypeboxFormat.Clear),
  Reset: bumping(TypeboxFormat.Reset),
}

// A WeakMap of compiled validators that is replaced by an empty one once the
// format registry has changed since it was created. Call it on every lookup.
export function compiledCache<K extends object, V>(): () => WeakMap<K, V> {
  let cache = new WeakMap<K, V>()
  let seen = revision
  return () => {
    if (seen !== revision) {
      cache = new WeakMap()
      seen = revision
    }
    return cache
  }
}
