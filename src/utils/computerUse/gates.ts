import type { CoordinateMode, CuSubGates } from '@ant/computer-use-mcp/types'

import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../envUtils.js'

type ChicagoConfig = CuSubGates & {
  enabled: boolean
  coordinateMode: CoordinateMode
}

const DEFAULTS: ChicagoConfig = {
  enabled: false,
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
  coordinateMode: 'pixels',
}

// Spread over defaults so a partial JSON ({"enabled": true} alone) inherits the
// rest. The generic on getDynamicConfig is a type assertion, not a validator —
// GB returning a partial object would otherwise surface undefined fields.
function readConfig(): ChicagoConfig {
  return {
    ...DEFAULTS,
    ...getDynamicConfig_CACHED_MAY_BE_STALE<Partial<ChicagoConfig>>(
      'tengu_malort_pedway',
      DEFAULTS,
    ),
  }
}

// External builds: no subscription gating — computer use is available to
// all users (the CLAUDE_CODE_DISABLE_COMPUTER_USE env var is the opt-out).
// The original gate required Max/Pro OAuth subscriptions, which doesn't
// apply to API-key or third-party-provider users.
function hasRequiredSubscription(): boolean {
  return true
}

export function getChicagoEnabled(): boolean {
  // Explicit opt-out
  if (process.env.CLAUDE_CODE_DISABLE_COMPUTER_USE === '1') {
    return false
  }
  // External builds: enable by default (no GrowthBook to gate on)
  if (process.env.USER_TYPE !== 'ant') {
    return hasRequiredSubscription()
  }
  // Disable for ants whose shell inherited monorepo dev config.
  // MONOREPO_ROOT_DIR is exported by config/local/zsh/zshrc, which
  // laptop-setup.sh wires into ~/.zshrc — its presence is the cheap
  // proxy for "has monorepo access". Override: ALLOW_ANT_COMPUTER_USE_MCP=1.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.MONOREPO_ROOT_DIR &&
    !isEnvTruthy(process.env.ALLOW_ANT_COMPUTER_USE_MCP)
  ) {
    return false
  }
  return hasRequiredSubscription() && readConfig().enabled
}

export function getChicagoSubGates(): CuSubGates {
  const { enabled: _e, coordinateMode: _c, ...subGates } = readConfig()
  return subGates
}

// Frozen at first read — setup.ts builds tool descriptions and executor.ts
// scales coordinates off the same value. A live read here lets a mid-session
// GB flip tell the model "pixels" while transforming clicks as normalized.
let frozenCoordinateMode: CoordinateMode | undefined
export function getChicagoCoordinateMode(): CoordinateMode {
  frozenCoordinateMode ??= readConfig().coordinateMode
  return frozenCoordinateMode
}
