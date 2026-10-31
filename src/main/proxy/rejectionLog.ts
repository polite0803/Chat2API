import type { RequestLogEntry } from '../store/types.ts'

/**
 * A request the proxy refused never reaches a provider, so no route records it.
 * Without these rows a client hammering a wrong path or a stale key reads as
 * "no traffic" on the same dashboard that reports the refusals as errors.
 */
export function buildRejectionLogEntry(input: {
  method: string
  path: string
  statusCode: number
  code: string
  message: string
  startedAt: number
  now: number
  /** The model a client asked for; empty when the body was never parsed. */
  model: string
}): Omit<RequestLogEntry, 'id'> {
  const latency = Math.max(0, input.now - input.startedAt)

  return {
    timestamp: input.startedAt,
    status: 'error',
    statusCode: input.statusCode,
    method: input.method,
    url: input.path,
    model: input.model,
    responseStatus: input.statusCode,
    latency,
    isStream: false,
    errorMessage: `${input.code}: ${input.message}`,
  }
}

/**
 * The key check runs before the body parser on purpose, so an unauthenticated
 * request has no readable model. Read it only when the body was actually parsed,
 * and never guess one.
 */
export function requestedModelOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return ''
  }
  const model = (body as { model?: unknown }).model
  return typeof model === 'string' ? model : ''
}

/**
 * The same refusal row, built from a live Koa context. `server.ts` inlines this
 * for the refusals its own middleware sees (bad key, unmounted path); a route
 * that answers mid-handler (`route_disabled`) calls it instead, so every
 * refusal shares one format and one stats path. Kept pure (no store import) so
 * `node --test` can exercise it without an Electron runtime.
 */
export function rejectionEntryFromContext(
  ctx: {
    method: string
    path: string
    state?: { startedAt?: unknown }
    request?: { body?: unknown }
  },
  statusCode: number,
  code: string,
  message: string,
): Omit<RequestLogEntry, 'id'> {
  const startedAt = typeof ctx.state?.startedAt === 'number' ? ctx.state.startedAt : Date.now()

  return buildRejectionLogEntry({
    method: ctx.method,
    path: ctx.path,
    statusCode,
    code,
    message,
    startedAt,
    now: Date.now(),
    model: requestedModelOf(ctx.request?.body),
  })
}
