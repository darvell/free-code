/**
 * Stub for @ant/computer-use-mcp/sentinelApps.
 *
 * Categorizes macOS apps by security sensitivity so the permission UI
 * can show warnings for shell-equivalent, filesystem, or system-settings apps.
 */

// Bundle IDs that grant shell-equivalent access
const SHELL_APPS = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'co.zeit.hyper',
  'com.github.atom', // Atom had integrated terminal
  'com.microsoft.VSCode',
  'com.todesktop.230313mzl4w4u92', // Cursor
  'dev.zed.Zed',
])

// Bundle IDs that can read/write arbitrary files
const FILESYSTEM_APPS = new Set([
  'com.apple.finder',
  'com.trankynam.aText',
  'com.cocoatech.PathFinder',
])

// Bundle IDs that can change system settings
const SYSTEM_SETTINGS_APPS = new Set([
  'com.apple.systempreferences',
  'com.apple.SystemPreferences',
])

/**
 * Returns the sentinel category for a given bundle ID, or undefined if
 * the app is not in any sensitive category.
 *
 * @param {string} bundleId - macOS application bundle identifier
 * @returns {'shell' | 'filesystem' | 'system_settings' | undefined}
 */
function getSentinelCategory(bundleId) {
  if (SHELL_APPS.has(bundleId)) return 'shell'
  if (FILESYSTEM_APPS.has(bundleId)) return 'filesystem'
  if (SYSTEM_SETTINGS_APPS.has(bundleId)) return 'system_settings'
  return undefined
}

module.exports = { getSentinelCategory }
