/** `@deepseek-ai/dsh-credentials` 的宿主垫片：ref 只是带类型的字符串。 */
export type CredentialRef = string

export const credentialRef = <T>(value: T): T => value
