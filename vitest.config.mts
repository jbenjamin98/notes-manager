import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer code imports shared modules through the same alias the app build uses.
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  // Default pools crash on Node 26 + vitest 5.1 ("reading 'config'"); vmThreads works.
  test: { include: ['src/**/*.test.ts'], environment: 'node', pool: 'vmThreads' }
})
