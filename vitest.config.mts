import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Default pools crash on Node 26 + vitest 5.1 ("reading 'config'"); vmThreads works.
  test: { include: ['src/**/*.test.ts'], environment: 'node', pool: 'vmThreads' }
})
