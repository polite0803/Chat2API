/**
 * Normalisation for the context-compression configuration.
 *
 * Kept apart from `store.ts` so it can be tested without electron: a hand-edited
 * `data.json` must never enable compression with an unrecognised strength, and a
 * pre-upgrade install (no `compression` key at all) must read as disabled.
 */
import type { CompressionConfig } from '../../shared/types.ts'
import {
  COMPRESSION_AGGRESSIVENESS,
  DEFAULT_COMPRESSION_CONFIG,
} from '../../shared/types.ts'

export function normalizeCompressionConfig(
  input?: Partial<CompressionConfig> | null
): CompressionConfig {
  // An absent or non-object value falls back to the default, which is disabled:
  // an upgrade must never turn the feature on behind the user's back.
  if (!input || typeof input !== 'object') return { ...DEFAULT_COMPRESSION_CONFIG }

  return {
    // Only an explicit `true` enables it. Anything else (undefined, a stray
    // string, null) keeps the safe default.
    enabled: input.enabled === true,
    aggressiveness: COMPRESSION_AGGRESSIVENESS.includes(
      input.aggressiveness as CompressionConfig['aggressiveness']
    )
      ? (input.aggressiveness as CompressionConfig['aggressiveness'])
      : DEFAULT_COMPRESSION_CONFIG.aggressiveness,
  }
}
