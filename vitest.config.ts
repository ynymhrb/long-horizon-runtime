import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: {
    deps: {
      inline: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol'],
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
