/**
 * Normalisation for the output-verbosity steering configuration.
 *
 * Same rationale as `compressionConfig.ts`: a hand-edited `data.json` must never
 * push the steering block to an undefined level, and a pre-upgrade install (no
 * `outputSteering` key at all) must read as disabled.
 */

import type { OutputSteeringConfig } from '../../shared/types.ts'
import {
  DEFAULT_OUTPUT_STEERING_CONFIG,
  OUTPUT_STEERING_LEVELS,
} from '../../shared/types.ts'

export function normalizeOutputSteeringConfig(
  input?: Partial<OutputSteeringConfig> | null
): OutputSteeringConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_OUTPUT_STEERING_CONFIG }

  const rawLevel = Number(input.level)
  const level = OUTPUT_STEERING_LEVELS.includes(rawLevel)
    ? rawLevel
    : DEFAULT_OUTPUT_STEERING_CONFIG.level

  // Only an explicit `true` enables it. When disabled the level is preserved so
  // the user's choice survives a toggle, but `applyVerbositySteering` is never
  // called with it, so nothing changes the prompt.
  return { enabled: input.enabled === true, level }
}
