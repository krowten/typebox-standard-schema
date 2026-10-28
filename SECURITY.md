# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's advisory form](https://github.com/krowten/typebox-standard-schema/security/advisories/new)
rather than in a public issue. Include the schema, the input, what you expected and what
happened, and the version you were running.

## Supported versions

The package is pre-1.0. Fixes land on the latest release; older versions are not patched.

## What counts as a vulnerability here

Projections are meant to be a data boundary. Treat these as security issues:

- a `Type.Read` result that carries a field marked `writeOnly` (a password, a token);
- a `Type.Write` result that carries a client-supplied field marked `readOnly`;
- data the full schema rejects passing validation of a projection;
- validation that throws, hangs, or takes far longer than the input's size justifies
  (validation is meant to report bad input as issues, never as an exception).

The README documents the cases where a mark deliberately cuts nothing (a mark on an array
item, a record value or a `Type.Cyclic` definition) and the coercion rules; behaviour
described there is not a vulnerability.
