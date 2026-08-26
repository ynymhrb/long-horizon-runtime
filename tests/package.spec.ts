import { describe, expect, test } from 'vitest'
import manifest from '../package.json' with { type: 'json' }
import { inject, name, pluginName } from '../src/index.js'

describe('package surface', () => {
  test('exports its DSH plugin name', () => {
    expect(pluginName).toBe('@deepseek-ai/dsh-long-task-runtime')
    expect(name).toBe('long-task-runtime')
    expect(inject).toEqual(['tools', 'subagents', 'systemPrompt'])
    expect(manifest.scripts.prepare).toBe('pnpm build')
    expect(manifest.exports['.'].import).toBe('./dist/index.js')
  })
})
