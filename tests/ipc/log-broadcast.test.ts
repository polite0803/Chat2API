import test from 'node:test'
import assert from 'node:assert/strict'

import { sendRequestLog } from '../../src/main/ipc/logBroadcast.ts'
import { IpcChannels } from '../../src/main/ipc/channels.ts'
import { currentLocalDay } from '../../src/shared/localDay.ts'
import type { RequestLogEntry } from '../../src/shared/types.ts'

function createEntry(): RequestLogEntry {
  return {
    id: 'entry-1',
    timestamp: currentLocalDay().start + 1000,
    status: 'success',
    statusCode: 200,
    method: 'POST',
    url: '/v1/chat/completions',
    model: 'glm-4.6',
    responseStatus: 200,
    latency: 120,
    isStream: true,
  }
}

test('a stored row is pushed on the request-log channel', () => {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const liveWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload })
      },
    },
  }
  const entry = createEntry()

  assert.equal(sendRequestLog(liveWindow, entry), true)
  assert.deepEqual(sent, [{ channel: IpcChannels.REQUEST_LOGS_NEW, payload: entry }])
})

test('nothing is pushed when there is no live window', () => {
  const sent: unknown[] = []
  const destroyedWindow = {
    isDestroyed: () => true,
    webContents: {
      send: (_channel: string, payload: unknown) => {
        sent.push(payload)
      },
    },
  }

  assert.equal(sendRequestLog(null, createEntry()), false)
  assert.equal(sendRequestLog(destroyedWindow, createEntry()), false)
  assert.deepEqual(sent, [])
})
