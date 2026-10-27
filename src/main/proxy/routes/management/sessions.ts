/**
 * Management API - Session Routes
 *
 * The server-side session table was retired on 2026-10-27: nothing ever populated it
 * (conversation continuity travels in the request message history), so these routes
 * answer 501 instead of pretending an empty table is the truth.
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import type { ManagementApiResponse } from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

function retiredResponse(): ManagementApiResponse {
  return {
    success: false,
    error: {
      code: 'sessions_api_retired',
      message:
        'The session table was removed. Conversation continuity is carried by the request message history, so there is no server-side session to list or delete.',
    },
  }
}

router.get('/sessions', managementAuthMiddleware, async (ctx: Context) => {
  ctx.status = 501
  ctx.body = retiredResponse()
})

router.get('/sessions/:id', managementAuthMiddleware, async (ctx: Context) => {
  ctx.status = 501
  ctx.body = retiredResponse()
})

router.delete('/sessions/:id', managementAuthMiddleware, async (ctx: Context) => {
  ctx.status = 501
  ctx.body = retiredResponse()
})

router.delete('/sessions', managementAuthMiddleware, async (ctx: Context) => {
  ctx.status = 501
  ctx.body = retiredResponse()
})

export default router
