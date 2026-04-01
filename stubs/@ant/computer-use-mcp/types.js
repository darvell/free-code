/**
 * Runtime type exports for @ant/computer-use-mcp/types.
 *
 * TypeScript consumers import these as `import type { ... }` — the runtime
 * exports here exist so the module resolves at build/bundle time. The only
 * value exports are constants that consuming code reads at runtime.
 */

// ── Grant flags ──────────────────────────────────────────────────────────────

/**
 * Default grant flags for computer use permission responses.
 * These control elevated capabilities that require explicit user consent
 * beyond basic app access: clipboard read/write and system key combos
 * (e.g. Cmd+Q, Cmd+W). The ComputerUseApproval dialog presents these
 * as checkboxes, defaulting to this object.
 */
const DEFAULT_GRANT_FLAGS = Object.freeze({
  clipboardRead: true,
  clipboardWrite: true,
  systemKeyCombos: true,
});

module.exports = { DEFAULT_GRANT_FLAGS };
