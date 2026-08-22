import { describe, expect, test } from 'vitest'
import { pluginName } from '../src/index.js'

describe('package surface', () => {
  test('exports its DSH plugin name', () => {
    expect(pluginName).toBe('@deepseek-ai/dsh-long-task-runtime')
  })
})
