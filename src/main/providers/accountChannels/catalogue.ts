/**
 * The ten account channels shipped by the vendored pack.
 *
 * This is metadata only: login flows, account pools, credit claims and model
 * catalogues all come from `vendor/channel-pack` at runtime. The ids here must
 * match the pack's provider ids exactly, because they double as the provider
 * record id and the model namespace (`<id>/<model>`).
 */
import type { ChannelDefinition } from '../../../shared/channels'

export const ACCOUNT_CHANNELS: readonly ChannelDefinition[] = [
  {
    id: 'lobsterai',
    name: 'LobsterAI (有道)',
    vendor: '有道',
    loginKind: 'browser',
    description: '网页登录后领取每日积分，走有道龙虾的免费模型额度。',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    vendor: 'Qoder',
    loginKind: 'device-code',
    description: '设备码登录，账号池按顺序分担请求并共享每日积分。',
  },
  {
    id: 'qodercn',
    name: 'Qoder (中国版)',
    vendor: '阿里',
    loginKind: 'device-code',
    description: '中国版 Qoder，与海外版同协议、不同产品线。',
  },
  {
    id: 'trae',
    name: 'TRAE (字节)',
    vendor: '字节跳动',
    loginKind: 'browser',
    description: '浏览器登录 TRAE，用签到积分驱动其内置模型。',
  },
  {
    id: 'cline',
    name: 'Cline',
    vendor: 'Cline',
    loginKind: 'device-code',
    description: '设备码授权 Cline，按订阅额度（不是余额）计费。',
  },
  {
    id: 'loomy',
    name: 'Loomy (讯飞)',
    vendor: '科大讯飞',
    loginKind: 'browser',
    description: '网页登录 Loomy，每日首次登录自动发放额度。',
  },
  {
    id: 'raccoon',
    name: 'Raccoon (商汤)',
    vendor: '商汤',
    loginKind: 'browser',
    description: '浏览器登录 Raccoon，多个模型共用一份免费额度。',
  },
  {
    id: 'minimax',
    name: 'MiniMax Code',
    vendor: 'MiniMax',
    loginKind: 'device-code',
    description: 'OAuth 设备码授权，支持每日签到领取。',
  },
  {
    id: 'zcode',
    name: 'ZCode (智谱)',
    vendor: '智谱',
    loginKind: 'browser',
    description: '浏览器登录 ZCode，按免费套餐余额扣费。',
  },
  {
    id: 'gemini',
    name: 'Gemini Code Assist',
    vendor: 'Google',
    loginKind: 'oauth',
    description: '本地回调 OAuth 授权 Google 账号，走 Cloud Code Assist 免费线。',
  },
]

const CHANNEL_IDS = new Set(ACCOUNT_CHANNELS.map(channel => channel.id))

export function isAccountChannelId(id: string): boolean {
  return CHANNEL_IDS.has(id)
}

export function getChannelDefinition(id: string): ChannelDefinition | undefined {
  return ACCOUNT_CHANNELS.find(channel => channel.id === id)
}

/** Provider-record id for a channel. Same as the pack provider id on purpose. */
export function channelProviderId(id: string): string {
  return id
}

/** Display name for a model exposed by a channel (`<channel>/<model>`). */
export function channelModelName(channelId: string, modelId: string): string {
  return `${channelId}/${modelId}`
}
