/**
 * Model catalogue normalisation for account channels.
 *
 * The pack's `model.list` RPC is the only place that knows a model's **credit
 * weight**: there is no numeric field for it, the multiplier is appended to the
 * display name. The formats in the vendored tree are:
 *
 *   `MiniMax M3 · x4.0`          rate only            (loomy / lobsterai / qoder)
 *   `GLM-5-3-Flash · x0.2→x0.1`  base → effective     (qoder promo / raccoon)
 *   `Qwen3.8-Flash · 免费`       free                 (qoder / cline / raccoon)
 *
 * So the parser below is the single place that turns those labels into
 * `{ name, weight, baseWeight, free }`. Everything else (UI badges, `/v1/models`
 * display names) reads the parsed shape.
 *
 * ⚠️ 缺失 `weight` 一律保持 undefined（= 不知道），绝不回落成 0：trae / minimax
 * 这些渠道根本不报倍率，把它们当成免费模型会让用户按免费额度选一个按量计费的
 * 模型。
 */
import type { ChannelModelInfo } from '../../../shared/channels'

/** `名称 · 免费` / `名称 · x1.5` / `名称 · x0.2→x0.1`。 */
const LABEL_SUFFIX = /^(.*?)\s*·\s*(免费|x\d+(?:\.\d+)?(?:\s*→\s*x\d+(?:\.\d+)?)?)$/

export interface ParsedModelLabel {
  name: string
  free: boolean
  weight?: number
  baseWeight?: number
}

/** 把展示名拆成「干净的名字 + 倍率」。识别不了就原样返回，不猜。 */
export function splitModelLabel(raw: unknown): ParsedModelLabel {
  const label = typeof raw === 'string' ? raw.trim() : ''
  const match = LABEL_SUFFIX.exec(label)
  if (match === null) return { name: label, free: false }

  const name = match[1].trim()
  const marker = match[2]
  if (marker === '免费') return { name, free: true, weight: 0 }

  const values = marker.split('→').map(part => Number(part.trim().slice(1)))
  if (values.some(value => !Number.isFinite(value))) return { name, free: false }

  const weight = values[values.length - 1]
  return {
    name,
    free: weight === 0,
    weight,
    ...(values.length > 1 ? { baseWeight: values[0] } : {}),
  }
}

/**
 * 把 `model.list` 的返回值归一化成目录条目。
 *
 * 畸形输入一律跳过（这是外部数据），`isFree` 照实透传 —— 上游没写就保持未知，
 * 与 `model.list` 端点「缺失即不推导」的口径一致。
 */
export function readModelList(value: unknown): ChannelModelInfo[] {
  const models = (value as { models?: unknown } | undefined)?.models
  if (!Array.isArray(models)) return []

  const out: ChannelModelInfo[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id.length === 0) continue

    const label = splitModelLabel(record.name ?? id)
    const declaredFree = record.isFree === true
    const weight = label.weight ?? (declaredFree ? 0 : undefined)
    out.push({
      id,
      name: label.name,
      free: label.free || declaredFree || weight === 0,
      disabled: record.disabled === true,
      dead: record.dead === true,
      ...(weight === undefined ? {} : { weight }),
      ...(label.baseWeight === undefined ? {} : { baseWeight: label.baseWeight }),
    })
  }
  return out
}
