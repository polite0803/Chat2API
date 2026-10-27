import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import {
  getLatestToolCallingSmokeResult,
  runToolCallingSmoke,
} from '../../toolCalling/diagnostics'
import type { ManagementApiResponse } from '../../../../shared/types'
import type { ToolClientAdapterId } from '../../../../shared/toolCalling'

const router = new Router({ prefix: '/v0/management/tool-calling' })

router.use(managementAuthMiddleware)

router.get('/status', async (ctx: Context) => {
  const config = ConfigManager.get()

  ctx.body = {
    success: true,
    data: {
      config: config.toolCallingConfig,
      latestSmokeResult: getLatestToolCallingSmokeResult(),
    },
  } as ManagementApiResponse
})

router.post('/smoke', async (ctx: Context) => {
  const body = ctx.request.body as { clientAdapterId?: ToolClientAdapterId }
  const config = ConfigManager.get()
  const clientAdapterId = body.clientAdapterId ?? config.toolCallingConfig.clientAdapterId

  ctx.body = {
    success: true,
    data: runToolCallingSmoke(clientAdapterId),
  } as ManagementApiResponse
})

export default router
