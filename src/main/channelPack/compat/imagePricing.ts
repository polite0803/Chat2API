/**
 * `src/image-pricing.js` 的宿主侧替身。
 *
 * 上游 `vendor/channel-pack/src/llm-register-compat.ts` 会从宿主仓库越界导入
 * `../../../src/image-pricing.js` 的 `FALLBACK_IMAGE_PRICING`（上游只附带了
 * `src/image-pricing.d.ts` 声明，实现文件不在参考仓库里）。本仓库没有那套图片
 * 定价表，故这里按 d.ts 的形状给一个恒等兜底：
 *
 * - 形状必须与声明一致，否则 `wrapAdapterWithTokenLedger` 的 Proxy 在宿主读取
 *   `imageRequestPricing` 时会拿到形状不对的对象；
 * - 语义只是「跨宿主版本的同步视觉 Token 估算，不是厂商账单或上限」，所以这里
 *   用固定估算值而不是去猜各家真实单价；
 * - 本仓库的 worker 从不调用 `imageRequestPricing`（记账在 dsh-llm 侧），
 *   这个替身只为让 bundle 能解析并通过形状检查。
 */

/** 单张未 offload 图片的保守视觉 Token 估算（与主流厂商的 85~1700 区间同量级）。 */
const VISUAL_TOKENS_PER_IMAGE = 1024

export const FALLBACK_IMAGE_PRICING: Readonly<{
  priceImages(images: readonly { offloaded?: boolean }[]): {
    visualTokens: number
    text: string
  }[]
}> = Object.freeze({
  priceImages(images: readonly { offloaded?: boolean }[]) {
    return images.map(image => ({
      // 已 offload 的图片不占上下文视觉 Token（内容在附件里，由工具按需读取）。
      visualTokens: image.offloaded === true ? 0 : VISUAL_TOKENS_PER_IMAGE,
      text: '',
    }))
  },
})
