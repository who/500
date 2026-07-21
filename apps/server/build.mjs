import { build } from 'esbuild';

await build({
  // hardWorker is a separate entry: it must exist as a real file on disk for
  // `new Worker(new URL('./workers/hardWorker.js', import.meta.url))`.
  entryPoints: ['src/index.ts', 'src/workers/hardWorker.ts'],
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  // CJS deps (ws) require node builtins at runtime; an ESM bundle needs a
  // real `require` in scope for that.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // Dev-only dependency behind a dynamic import (hardPool.ts bundles the
  // worker on the fly when running from TS sources); never reached in dist.
  external: ['esbuild'],
});
