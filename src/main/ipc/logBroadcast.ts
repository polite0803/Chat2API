import { IpcChannels } from './channels.ts'
import type { RequestLogEntry } from '../../shared/types.ts'

/** The slice of BrowserWindow this needs, so tests can pass a fake sink. */
export interface RendererSink {
  isDestroyed(): boolean
  webContents: {
    send(channel: string, payload: unknown): void
  }
}

/**
 * Pushes one stored request-log row to the open window so the log list can
 * prepend it instead of polling. Only persisted rows are sent: a row the disk
 * does not have must not appear in the list a refresh would then drop.
 */
export function sendRequestLog(window: RendererSink | null, entry: RequestLogEntry): boolean {
  if (!window || window.isDestroyed()) {
    return false
  }

  window.webContents.send(IpcChannels.REQUEST_LOGS_NEW, entry)
  return true
}
