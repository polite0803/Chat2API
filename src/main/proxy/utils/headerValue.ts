/**
 * 响应头值的编码。
 *
 * Node 写响应头时按 Latin-1 校验值：除 `\t` 外的 `0x00-0x1F` 字符和任何
 * `> 0xFF` 的字符都会抛 `ERR_INVALID_CHAR`，错误文本就是
 * `Invalid character in header content ["X-Chat2API-Route"]`。
 *
 * 这不是理论问题：12 个账号渠道里有 8 个的名字带中文（`TRAE (字节)`、
 * `Qoder (中国版)` …），自定义供应商的名字也是用户自己填的；而 auto 路由会把
 * `实际模型 (供应商名)` 写进 `X-Chat2API-Route`。于是只要 auto 命中一个这类
 * 渠道，转发其实已经成功，请求却在写响应头时抛错，被路由的 catch 兜成
 * `500 {"type":"internal_error"}` —— 客户端看到的是「auto 用不了」。
 *
 * 规则：
 * - 纯可打印 ASCII（含 `\t`）原样返回。模型 id、聚合条目名都属于这种，客户端
 *   看到的值与以前完全一致。
 * - 一旦出现别的字符，就只把这些字符按 UTF-8 百分号编码，ASCII 骨架（模型 id、
 *   括号、空格）仍然可读；编码分支里 `%` 也转义成 `%25`，所以整串可以被
 *   `decodeURIComponent` 原样还原。
 * - 输出只含 `0x20-0x7E`，CR/LF 因此变成 `%0D%0A`，不可能注入新的响应头。
 */
const PRINTABLE_ASCII_ONLY = /^[\t\x20-\x7e]*$/

/** `X-Chat2API-Route` 的值：`<实际模型> (<供应商名>)`，两个路由共用同一处拼接 */
export function routeHeaderValue(actualModel: string, providerName: string): string {
  return toHeaderValue(`${actualModel} (${providerName})`)
}

/** 把任意动态字符串变成合法的响应头值（非 ASCII 按 UTF-8 百分号编码） */
export function toHeaderValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : String(value)
  if (PRINTABLE_ASCII_ONLY.test(text)) return text

  let encoded = ''
  // Buffer 的 UTF-8 编码会把孤立代理项写成 U+FFFD，编码本身不会抛错。
  for (const byte of Buffer.from(text, 'utf8')) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x25) {
      encoded += String.fromCharCode(byte)
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return encoded
}
