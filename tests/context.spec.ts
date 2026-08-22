import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ArtifactStore } from '../src/artifacts.js'
import { ContextBroker } from '../src/context.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('artifacts and execution context', () => {
  test('stores oversized content by hash-addressed file reference', () => {
    const directory = mkdtempSync(join(tmpdir(), 'long-task-artifact-'))
    directories.push(directory)
    const artifacts = new ArtifactStore(directory, 100)
    const artifact = artifacts.put({ id: 'a-1', taskId: 't-1', type: 'analysis', content: 'x'.repeat(101) })
    expect(artifact.storage).toBe('file')
    expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('includes only validated direct-dependency artifacts', () => {
    const broker = new ContextBroker({
      objective: 'ship',
      tasks: new Map([
        ['a', { id: 'a', objective: 'root', dependsOn: [] }],
        ['b', { id: 'b', objective: 'direct', dependsOn: ['a'] }],
        ['c', { id: 'c', objective: 'target', dependsOn: ['b'] }],
      ]),
      artifacts: [
        { id: 'from-a', taskId: 'a', type: 'analysis', content: 'ancestor', validated: true },
        { id: 'from-b', taskId: 'b', type: 'analysis', content: 'direct', validated: true },
        { id: 'bad-b', taskId: 'b', type: 'analysis', content: 'bad', validated: false },
      ],
    })
    expect(broker.build('c').artifacts.map(artifact => artifact.id)).toEqual(['from-b'])
  })
})
