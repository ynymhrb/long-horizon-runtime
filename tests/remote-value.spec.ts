import { expect, test } from 'vitest'
import { remoteValue } from '../client/remote-value.js'
test('unwraps a successful Typert remote value and rejects an error result', () => {
  expect(remoteValue({ ok: true, value: { id: 'lt_a' } })).toEqual({ id: 'lt_a' })
  expect(() => remoteValue({ ok: false, error: { message: 'bad' } })).toThrow('bad')
})
