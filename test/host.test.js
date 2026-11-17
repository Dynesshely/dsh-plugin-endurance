import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecordWriter } from '../src/host.js'

test('the record writer pins the first module instance that accepts the session', () => {
  const calls = []
  const writer = createRecordWriter([
    {
      appendPluginRecord() {
        calls.push('first')
        throw new Error('brand mismatch')
      },
    },
    {
      appendPluginRecord() {
        calls.push('second')
        return 7
      },
    },
  ])
  assert.equal(writer.append({ id: 's1' }, 'plugin:dsh-plugin-endurance/state', { a: 1 }), 7)
  assert.equal(writer.append({ id: 's1' }, 'plugin:dsh-plugin-endurance/state', { a: 2 }), 7)
  assert.deepEqual(calls, ['first', 'second', 'second'])
})

test('the record writer fails when no module accepts the session', () => {
  const writer = createRecordWriter([
    {
      appendPluginRecord() {
        throw new Error('brand mismatch')
      },
    },
  ])
  assert.throws(
    () => writer.append({ id: 's1' }, 'plugin:dsh-plugin-endurance/state', {}),
    /no host Session module instance/,
  )
})
