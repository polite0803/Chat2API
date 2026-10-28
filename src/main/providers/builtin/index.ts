import opencodeConfig from './opencode.ts'
import type { BuiltinProviderConfig } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  opencodeConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  opencode: opencodeConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export { opencodeConfig }

export default builtinProviders
