/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types'
import { loadBalancer } from '../loadbalancer'
import { storeManager } from '../../store/store'
import { modelMapper } from '../modelMapper'
import { AUTO_MODEL_ID } from '../autoRouter'
import { aliasMappingKeys, contextWindowOf, matchesCatalogueName } from '../../store/modelServing'

const router = new Router({ prefix: '/v1' })

/**
 * 所有供应商目录里的名字（含已停用的）。这些由供应商自己按「是否在服务」广告；
 * 聚合与账号通道每次同步都会按模型往全局映射表里写一条，所以映射表只能用来
 * 补用户自己建的别名，否则刚停用的模型会从这里回到客户端清单。
 */
function providerCatalogueNames(): Set<string> {
  const names = new Set<string>()
  for (const provider of storeManager.getProviders()) {
    for (const model of storeManager.getModelCatalogue(provider.id)) {
      names.add(model.displayName)
    }
  }
  return names
}

/**
 * Get all available models
 */
router.get('/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(p => p.enabled)
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  // 虚拟模型：请求时由 autoRouter 在全部可用供应商/模型中挑选目标
  if (storeManager.getConfig().autoRouting?.enabled !== false) {
    addedModels.add(AUTO_MODEL_ID)
    models.push({
      id: AUTO_MODEL_ID,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'auto-router',
    })
  }

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (!addedModels.has(model.displayName)) {
        addedModels.add(model.displayName)
        // 只有上游报过窗口才发这个键；用户自建/聚合未标注的都保持省略。
        const window = contextWindowOf(provider.modelCapabilities, model.displayName)
        models.push({
          id: model.displayName,
          object: 'model',
          created: Math.floor(provider.createdAt / 1000),
          owned_by: provider.name,
          ...(window === undefined ? {} : { context_window: window }),
        })
      }
    }
  }

  const config = storeManager.getConfig()
  for (const requestModel of aliasMappingKeys(config.modelMappings, providerCatalogueNames())) {
    if (!addedModels.has(requestModel)) {
      addedModels.add(requestModel)
      models.push({
        id: requestModel,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'model-mapping',
      })
    }
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model

  if (modelId.trim().toLowerCase() === AUTO_MODEL_ID) {
    // 自动路由关闭时，`auto` 既不在列表里，也不应该被单模型查询命中
    if (storeManager.getConfig().autoRouting?.enabled === false) {
      ctx.status = 404
      ctx.body = {
        error: {
          message: `Model '${modelId}' not found`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      }
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = {
      id: AUTO_MODEL_ID,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'auto-router',
    }
    return
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  if (mappings[modelId] && !providerCatalogueNames().has(modelId)) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = {
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'model-mapping',
    }
    return
  }

  const providers = storeManager.getProviders().filter(p => p.enabled)

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    // 用 find 而不是 some：命中那个**目录名**才是能力表的键，通配别名请求也要能查到窗口。
    const matched = effectiveModels.find(model => matchesCatalogueName(modelId, model.displayName))

    if (matched !== undefined) {
      const window = contextWindowOf(provider.modelCapabilities, matched.displayName)
      ctx.set('Content-Type', 'application/json')
      ctx.body = {
        id: modelId,
        object: 'model',
        created: Math.floor(provider.createdAt / 1000),
        owned_by: provider.name,
        ...(window === undefined ? {} : { context_window: window }),
      }
      return
    }
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
