import { defineConfig } from 'tsdown'

/** DSH loads browser plugins from its CJS module table, not from native ESM. */
export default defineConfig({
  entry: { client: 'client/index.js' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  sourcemap: true,
  clean: false,
  // React is a DSH platform module. Keeping it external is essential: a
  // bundled second React copy has a different hook dispatcher and crashes
  // every slot component at render time. zod is ordinary descriptor data and
  // is therefore safe to inline.
  external: ['react', 'react/jsx-runtime'],
  noExternal: (id: string) => id === 'zod' || id.startsWith('zod/'),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-long-task-runtime", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
