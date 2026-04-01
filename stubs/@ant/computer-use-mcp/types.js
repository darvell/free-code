/**
 * Stub type exports for @ant/computer-use-mcp/types.
 *
 * In the real package these are TypeScript types/interfaces. Since the
 * consuming code only imports them as `import type { ... }`, these
 * runtime exports exist solely so the module resolves without error at
 * build/bundle time and in plain JS environments.
 */

// CoordinateMode: 'pixels' | 'normalized'
// Exported as a no-op — TypeScript consumers use `import type`.

// CuSubGates shape (all boolean):
// {
//   pixelValidation: boolean
//   clipboardPasteMultiline: boolean
//   mouseAnimation: boolean
//   hideBeforeAction: boolean
//   autoTargetDisplay: boolean
//   clipboardGuard: boolean
// }

// ComputerUseHostAdapter shape:
// {
//   serverName: string
//   logger: Logger
//   executor: ComputerExecutor
//   ensureOsPermissions: () => Promise<...>
//   isDisabled: () => boolean
//   getSubGates: () => CuSubGates
//   getAutoUnhideEnabled: () => boolean
//   cropRawPatch: (...) => Buffer | null
// }

// Logger shape:
// {
//   silly(message, ...args): void
//   debug(message, ...args): void
//   info(message, ...args): void
//   warn(message, ...args): void
//   error(message, ...args): void
// }

module.exports = {};
