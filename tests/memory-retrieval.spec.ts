import { describe, expect, test } from 'vitest'
import { MemoryRetriever } from '../src/memory-retrieval.js'

describe('memory retrieval', () => {
  test('selects active source-linked memory by lexical score then stable ID', () => {
    const decision = new MemoryRetriever().retrieve({ query: 'typescript runtime', maxItems: 2, memories: [
      { id: 'm-b', content: 'runtime typescript guide', active: true, sourceRef: 'event:2' },
      { id: 'm-a', content: 'typescript runtime notes', active: true, sourceRef: 'event:1' },
      { id: 'm-c', content: 'other subject', active: true, sourceRef: 'event:3' },
    ] })
    expect(decision.selected.map(item => item.memoryId)).toEqual(['m-a', 'm-b'])
    expect(decision.excluded).toContainEqual({ memoryId: 'm-c', reason: 'zero_score' })
  })

  test('excludes inactive and unlinked memory before scoring', () => {
    const decision = new MemoryRetriever().retrieve({ query: 'runtime', maxItems: 3, memories: [
      { id: 'stale', content: 'runtime', active: false, sourceRef: 'event:1' },
      { id: 'unlinked', content: 'runtime', active: true },
      { id: 'valid', content: 'runtime', active: true, sourceRef: 'event:2' },
    ] })
    expect(decision.selected.map(item => item.memoryId)).toEqual(['valid'])
    expect(decision.excluded).toEqual(expect.arrayContaining([{ memoryId: 'stale', reason: 'inactive' }, { memoryId: 'unlinked', reason: 'missing_source' }]))
  })
})
