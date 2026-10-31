/**
 * Normalisation for the context-compression configuration.
 *
 * Kept apart from `store.ts` so it can be tested without electron: a hand-edited
 * `data.json` must never enable compression with an unrecognised strength, and a
 * pre-upgrade install (no `compression` key at all) inherits the shipped
 * default. A user who explicitly turned the feature off keeps it off.
 */
import type { CompressionConfig } from '../../shared/types.ts'
import {
  COMPRESSION_AGGRESSIVENESS,
  DEFAULT_COMPRESSION_CONFIG,
} from '../../shared/types.ts'

export function normalizeCompressionConfig(
  input?: Partial<CompressionConfig> | null
): CompressionConfig {
  // An absent or non-object value falls back to the shipped default.
  if (!input || typeof input !== 'object') return { ...DEFAULT_COMPRESSION_CONFIG }

  return {
    // Only an explicit `true` enables it; an explicit `false` keeps it off even
    // though the shipped default is on. A stray non-boolean also lands on off.
    enabled: input.enabled === true,
    aggressiveness: COMPRESSION_AGGRESSIVENESS.includes(
      input.aggressiveness as CompressionConfig['aggressiveness']
    )
      ? (input.aggressiveness as CompressionConfig['aggressiveness'])
      : DEFAULT_COMPRESSION_CONFIG.aggressiveness,
  }
}
