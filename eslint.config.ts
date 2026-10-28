import antfu from '@antfu/eslint-config'

export default antfu({
  // The docs site is its own SvelteKit app with its own toolchain.
  ignores: ['site/**'],
  rules: {
    // Prefer `type` over `interface` (interfaces are used only where TS
    // requires them, e.g. declaration merging in src/augment.ts).
    'ts/consistent-type-definitions': ['error', 'type'],
    // New in @antfu/eslint-config 10: breaks every ternary and multi-item
    // literal onto separate lines; the codebase keeps short ones inline.
    'antfu/reasonable-newline': 'off',
  },
}, {
  // The fuzzer is a command-line tool: printing is its output.
  files: ['test/fuzz/run.ts'],
  rules: { 'no-console': 'off' },
})
