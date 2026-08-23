import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

  test('removes only artifact files owned by its store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'long-task-artifact-'))
    directories.push(directory)
    const artifacts = new ArtifactStore(directory, 1)
    const artifact = artifacts.put({ id: 'a-1', taskId: 't-1', type: 'analysis', content: 'xx' })
    artifacts.removeIfOwned(artifact.path!)
    expect(existsSync(artifact.path!)).toBe(false)
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

  test('carries L1 dependency summaries and L2 project constraints, decisions, and evidence', () => {
    const broker = new ContextBroker({
      objective: 'ship',
      constraints: ['use TypeScript'],
      decisions: [{ type: 'scope', payload: { choice: 'v1' } }],
      evidence: [{ taskId: 'a', value: { source: 'test-report' } }],
      tasks: new Map([
        ['a', { id: 'a', objective: 'research', dependsOn: [], summary: 'facts collected' }],
        ['b', { id: 'b', objective: 'implement', dependsOn: ['a'] }],
      ]),
      artifacts: [],
    })

    expect(broker.build('b')).toMatchObject({
      l1DependencySummaries: [{ taskId: 'a', objective: 'research', summary: 'facts collected' }],
      l2ProjectContext: {
        constraints: ['use TypeScript'],
        decisions: [{ type: 'scope', payload: { choice: 'v1' } }],
        evidence: [{ taskId: 'a', value: { source: 'test-report' } }],
      },
    })
  })
})
