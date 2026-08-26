import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import manifest from '../package.json' with { type: 'json' }
import { inject, name, pluginName } from '../src/index.js'

describe('package surface', () => {
  test('exports its DSH plugin name', () => {
    expect(pluginName).toBe('@deepseek-ai/dsh-long-task-runtime')
    expect(name).toBe('long-task-runtime')
    expect(inject).toEqual(['tools', 'subagents', 'systemPrompt'])
    // Git installs must load the checked-in bundle directly. A prepare hook
    // would try to resolve this repository's private DSH development links.
    expect(manifest.scripts.prepare).toBeUndefined()
    expect(manifest.exports['.'].import).toBe('./dist/index.js')
    expect(existsSync(resolve(import.meta.dirname, '../dist/index.js'))).toBe(true)
  })
})
