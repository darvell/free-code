/**
 * @ant/computer-use-mcp — JS orchestration layer for Anthropic computer use.
 *
 * Provides:
 *   - Tool definitions (buildComputerUseTools) for the MCP tool list
 *   - MCP Server factory (createComputerUseMcpServer)
 *   - Session binding (bindSessionContext) — the core orchestration that
 *     wraps raw executor calls with permission checks, lock gating,
 *     coordinate scaling, display resolution, hide-before-action, and
 *     screenshot stashing
 *   - Image resize helpers (targetImageSize, API_RESIZE_PARAMS)
 *
 * Native work (screenshots, input) lives in @ant/computer-use-swift and
 * @ant/computer-use-input; this package wires them into an MCP-shaped
 * dispatch layer.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// ── Resize constants ────────────────────────────────────────────────────────

const API_RESIZE_PARAMS = Object.freeze({
  maxLongSide: 1280,
  maxShortSide: 800,
});

function targetImageSize(physW, physH, resizeParams) {
  const params = resizeParams || API_RESIZE_PARAMS;
  const longSide = Math.max(physW, physH);
  const shortSide = Math.min(physW, physH);

  if (longSide <= params.maxLongSide && shortSide <= params.maxShortSide) {
    return [physW, physH];
  }

  const scaleLong = params.maxLongSide / longSide;
  const scaleShort = params.maxShortSide / shortSide;
  const scale = Math.min(scaleLong, scaleShort);

  return [Math.round(physW * scale), Math.round(physH * scale)];
}

// ── Tool definitions ────────────────────────────────────────────────────────

function coordDesc(coordinateMode) {
  if (coordinateMode === 'normalized') {
    return 'Coordinates are normalized floats in [0, 1] relative to screenshot dimensions.';
  }
  return 'Coordinates are in pixels, matching the screenshot dimensions returned with each screenshot.';
}

function intProp(description) {
  return { type: 'integer', description };
}

function strProp(description) {
  return { type: 'string', description };
}

function coordProp(coordinateMode, description) {
  return {
    type: 'array',
    items: { type: coordinateMode === 'normalized' ? 'number' : 'integer' },
    minItems: 2,
    maxItems: 2,
    description,
  };
}

function buildRequestAccessDescription(installedAppNames) {
  let desc =
    'Request permission to control specific applications. Must be called before ' +
    'interacting with any application. The user will be prompted to approve access.';
  if (installedAppNames && installedAppNames.length > 0) {
    desc += '\n\nInstalled applications: ' + installedAppNames.join(', ');
  }
  return desc;
}

/**
 * Build the MCP tool definitions array for the computer-use tool set.
 * Uses the Anthropic computer use API tool format with coordinate arrays
 * and Anthropic-style tool names (left_click, right_click, etc.).
 */
function buildComputerUseTools(capabilities, coordinateMode, installedAppNames) {
  const coordNote = coordDesc(coordinateMode);

  const tools = [
    {
      name: 'screenshot',
      description:
        'Take a screenshot of the current screen. Returns a base64-encoded JPEG image ' +
        'with width and height. Use this to see what is on screen before interacting.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'left_click',
      description: 'Left-click at the specified coordinates. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to click'),
          modifiers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Modifier keys to hold during click (e.g. ["shift", "command"])',
          },
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'right_click',
      description: 'Right-click at the specified coordinates to open a context menu. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to right-click'),
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'middle_click',
      description: 'Middle-click at the specified coordinates. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to middle-click'),
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'double_click',
      description: 'Double-click at the specified coordinates. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to double-click'),
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'triple_click',
      description: 'Triple-click at the specified coordinates (selects a line of text). ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to triple-click'),
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'type',
      description:
        'Type the specified text at the current cursor position. For keyboard shortcuts, use the key tool instead.',
      inputSchema: {
        type: 'object',
        properties: {
          text: strProp('Text to type'),
        },
        required: ['text'],
      },
    },
    {
      name: 'key',
      description:
        'Press a key or key combination. Use xdotool-style key names joined with "+". ' +
        'Examples: "Return", "command+c", "ctrl+shift+a", "space", "BackSpace", "Tab".',
      inputSchema: {
        type: 'object',
        properties: {
          text: strProp(
            'Key or key combination in xdotool format (e.g. "Return", "command+c", "ctrl+shift+a")',
          ),
        },
        required: ['text'],
      },
    },
    {
      name: 'hold_key',
      description:
        'Press and hold a key or key combination for a specified duration. ' +
        'Useful for long-press interactions.',
      inputSchema: {
        type: 'object',
        properties: {
          text: strProp('Key or key combination to hold (xdotool format)'),
          duration: intProp('Duration in milliseconds to hold the key'),
        },
        required: ['text', 'duration'],
      },
    },
    {
      name: 'scroll',
      description:
        'Scroll at the specified coordinates. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to scroll at'),
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Scroll direction',
          },
          amount: intProp('Number of scroll units (default: 3)'),
        },
        required: ['coordinate', 'direction'],
      },
    },
    {
      name: 'mouse_move',
      description:
        'Move the mouse cursor to the specified coordinates without clicking. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] coordinate to move to'),
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'left_click_drag',
      description:
        'Drag from one position to another. Holds left mouse button at the start position, ' +
        'moves to the end position, then releases. If start_coordinate is omitted, drags from current cursor. ' +
        coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: coordProp(coordinateMode, '[x, y] end coordinate (drop target)'),
          start_coordinate: coordProp(coordinateMode, '[x, y] start coordinate (drag from). Omit to drag from current cursor.'),
        },
        required: ['coordinate'],
      },
    },
    {
      name: 'left_mouse_down',
      description: 'Press and hold the left mouse button at the current cursor position.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'left_mouse_up',
      description: 'Release the left mouse button at the current cursor position.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'cursor_position',
      description: 'Get the current cursor position.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'zoom',
      description:
        'Capture a zoomed-in region of the screen. Returns a high-resolution crop. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'array',
            items: { type: coordinateMode === 'normalized' ? 'number' : 'integer' },
            minItems: 4,
            maxItems: 4,
            description: '[x, y, width, height] of the region to zoom into',
          },
        },
        required: ['region'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for a specified number of seconds. Use to wait for animations or loading.',
      inputSchema: {
        type: 'object',
        properties: {
          duration: {
            type: 'number',
            description: 'Duration in seconds to wait',
          },
        },
        required: ['duration'],
      },
    },
    {
      name: 'read_clipboard',
      description: 'Read the current contents of the system clipboard.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'write_clipboard',
      description: 'Write text to the system clipboard.',
      inputSchema: {
        type: 'object',
        properties: {
          text: strProp('Text to write to clipboard'),
        },
        required: ['text'],
      },
    },
    {
      name: 'open_application',
      description: 'Open an application by its bundle ID.',
      inputSchema: {
        type: 'object',
        properties: {
          bundle_id: strProp('Bundle ID of the application to open (e.g. "com.apple.Safari")'),
        },
        required: ['bundle_id'],
      },
    },
    {
      name: 'list_granted_applications',
      description: 'List the applications that have been granted access for this session.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'request_access',
      description: buildRequestAccessDescription(installedAppNames),
      inputSchema: {
        type: 'object',
        properties: {
          app_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of the applications to request access for',
          },
        },
        required: ['app_names'],
      },
    },
    {
      name: 'switch_display',
      description:
        'Switch to a different display for screenshots and interaction. ' +
        'Use "auto" to let the system choose based on allowed app windows.',
      inputSchema: {
        type: 'object',
        properties: {
          display_name: strProp('Display name or "auto" for automatic resolution'),
        },
        required: ['display_name'],
      },
    },
  ];

  return tools;
}

// ── Coordinate scaling ──────────────────────────────────────────────────────

/**
 * Scale a coordinate pair from the model's coordinate space to the executor's
 * coordinate space. In 'pixels' mode the model sends pixels matching the
 * screenshot dimensions; in 'normalized' mode it sends [0..1] floats.
 *
 * The screenshot dimensions (lastScreenshotDims) tell us what coordinate
 * space the model is working in. The display dimensions tell us the physical
 * space the executor needs.
 */
function scaleCoord(coord, lastDims, coordinateMode) {
  if (!coord || coord.length < 2) return coord;
  const [x, y] = coord;

  if (coordinateMode === 'normalized') {
    // Normalized [0..1] → physical pixels on the display
    if (!lastDims) return [x, y];
    return [
      Math.round(x * lastDims.displayWidth),
      Math.round(y * lastDims.displayHeight),
    ];
  }

  // Pixels mode: the model's coordinates are in screenshot dimensions.
  // Scale to display's logical dimensions.
  if (!lastDims || lastDims.width === 0 || lastDims.height === 0) {
    return [x, y];
  }
  const scaleX = lastDims.displayWidth / lastDims.width;
  const scaleY = lastDims.displayHeight / lastDims.height;
  return [Math.round(x * scaleX), Math.round(y * scaleY)];
}

// ── Tools that defer lock acquisition ───────────────────────────────────────
// These tools don't directly interact with the screen, so they don't need
// to hold the cross-session lock. The lock is only acquired for tools that
// send input events or take screenshots.

const DEFERS_LOCK_ACQUIRE = new Set([
  'request_access',
  'list_granted_applications',
  'switch_display',
  'wait',
  'read_clipboard',
  'cursor_position',
]);

// ── Dispatch: tool call routing ─────────────────────────────────────────────

/**
 * Route a tool call to the appropriate executor method with full orchestration:
 * permission checks, lock gating, coordinate scaling, display resolution,
 * hide-before-action, and screenshot stashing.
 */
async function handleToolCall(adapter, toolName, args, coordinateMode, ctx) {
  const exec = adapter.executor;
  const logger = adapter.logger;
  const subGates = adapter.getSubGates();

  // ── Helpers ──────────────────────────────────────────────────────────

  const getAllowedBundleIds = () =>
    ctx.getAllowedApps().map(a => a.bundleId);

  const getDisplayId = () =>
    ctx.getSelectedDisplayId();

  const lastDims = () => ctx.getLastScreenshotDims();

  const scale = (coord) => scaleCoord(coord, lastDims(), coordinateMode);

  // ── Permission gate ──────────────────────────────────────────────────
  // request_access is the only tool that CREATES permissions. All other
  // tools that touch the screen require at least one allowed app.

  if (toolName !== 'request_access' && toolName !== 'list_granted_applications' &&
      toolName !== 'switch_display' && toolName !== 'wait') {
    const allowed = ctx.getAllowedApps();
    if (allowed.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No applications have been granted access. Use request_access first to get permission to control applications.',
        }],
        isError: true,
      };
    }
  }

  // ── Lock gate ────────────────────────────────────────────────────────
  // Check lock for non-deferred tools. If another session holds it, fail.

  if (!DEFERS_LOCK_ACQUIRE.has(toolName)) {
    const lockStatus = await ctx.checkCuLock();
    if (lockStatus.holder && !lockStatus.isSelf) {
      return {
        content: [{
          type: 'text',
          text: ctx.formatLockHeldMessage(lockStatus.holder),
        }],
        isError: true,
      };
    }
    if (!lockStatus.holder) {
      await ctx.acquireCuLock();
    }
  }

  // ── TCC (OS permissions) check ───────────────────────────────────────
  // For screenshot/input tools, verify Accessibility + Screen Recording.

  if (toolName === 'screenshot' || toolName === 'zoom') {
    const tccResult = await adapter.ensureOsPermissions();
    if (!tccResult.granted) {
      // Fire the permission dialog with tccState so the wrapper shows the
      // "Open System Settings" panel instead of the app allowlist.
      const response = await ctx.onPermissionRequest({
        apps: [],
        requestedFlags: {},
        tccState: {
          accessibility: tccResult.accessibility,
          screenRecording: tccResult.screenRecording,
        },
      });
      // TCC dialog always returns denied — it just guides the user to
      // System Settings. Return a message telling the model to retry.
      return {
        content: [{
          type: 'text',
          text: 'macOS permissions are required. The user has been prompted to grant Accessibility and Screen Recording permissions in System Settings. Please try again after they grant access.',
        }],
        isError: true,
      };
    }
  }

  // ── Hide before action ───────────────────────────────────────────────
  // For input tools, hide non-allowed apps so they don't interfere.

  const INPUT_TOOLS = new Set([
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'type', 'key', 'hold_key', 'scroll', 'mouse_move', 'left_click_drag',
    'left_mouse_down', 'left_mouse_up',
  ]);

  if (INPUT_TOOLS.has(toolName) && subGates.hideBeforeAction) {
    try {
      const hidden = await exec.prepareForAction(
        getAllowedBundleIds(),
        getDisplayId(),
      );
      if (hidden.length > 0) {
        ctx.onAppsHidden(hidden);
      }
    } catch (err) {
      logger.warn('prepareForAction failed, continuing: %s', err);
    }
  }

  // ── Tool dispatch ────────────────────────────────────────────────────

  switch (toolName) {
    case 'screenshot': {
      const result = await exec.screenshot({
        allowedBundleIds: getAllowedBundleIds(),
        displayId: getDisplayId(),
      });
      ctx.onScreenshotCaptured({
        width: result.width,
        height: result.height,
        displayWidth: result.displayWidth || result.width,
        displayHeight: result.displayHeight || result.height,
        displayId: result.displayId || getDisplayId() || 0,
        originX: result.originX || 0,
        originY: result.originY || 0,
      });
      return {
        content: [
          {
            type: 'image',
            data: result.base64,
            mimeType: 'image/jpeg',
          },
          {
            type: 'text',
            text: JSON.stringify({
              width: result.width,
              height: result.height,
            }),
          },
        ],
      };
    }

    case 'left_click': {
      const [x, y] = scale(args.coordinate);
      await exec.click(x, y, 'left', 1, args.modifiers);
      return { content: [{ type: 'text', text: 'Clicked.' }] };
    }

    case 'right_click': {
      const [x, y] = scale(args.coordinate);
      await exec.click(x, y, 'right', 1);
      return { content: [{ type: 'text', text: 'Right-clicked.' }] };
    }

    case 'middle_click': {
      const [x, y] = scale(args.coordinate);
      await exec.click(x, y, 'middle', 1);
      return { content: [{ type: 'text', text: 'Middle-clicked.' }] };
    }

    case 'double_click': {
      const [x, y] = scale(args.coordinate);
      await exec.click(x, y, 'left', 2);
      return { content: [{ type: 'text', text: 'Double-clicked.' }] };
    }

    case 'triple_click': {
      const [x, y] = scale(args.coordinate);
      await exec.click(x, y, 'left', 3);
      return { content: [{ type: 'text', text: 'Triple-clicked.' }] };
    }

    case 'type': {
      const flags = ctx.getGrantFlags();
      const multiline = args.text && args.text.includes('\n');
      const useClipboard = multiline && subGates.clipboardPasteMultiline &&
        flags.clipboardWrite;
      await exec.type(args.text, { viaClipboard: !!useClipboard });
      return { content: [{ type: 'text', text: 'Typed.' }] };
    }

    case 'key': {
      await exec.key(args.text, 1);
      return { content: [{ type: 'text', text: `Pressed ${args.text}.` }] };
    }

    case 'hold_key': {
      const keyNames = (args.text || '').split('+').filter(Boolean);
      const durationMs = args.duration || 500;
      await exec.holdKey(keyNames, durationMs);
      return { content: [{ type: 'text', text: `Held ${args.text} for ${durationMs}ms.` }] };
    }

    case 'scroll': {
      const [x, y] = scale(args.coordinate);
      const amount = args.amount || 3;
      let dx = 0, dy = 0;
      switch (args.direction) {
        case 'up': dy = -amount; break;
        case 'down': dy = amount; break;
        case 'left': dx = -amount; break;
        case 'right': dx = amount; break;
      }
      await exec.scroll(x, y, dx, dy);
      return { content: [{ type: 'text', text: `Scrolled ${args.direction}.` }] };
    }

    case 'mouse_move': {
      const [x, y] = scale(args.coordinate);
      await exec.moveMouse(x, y);
      return { content: [{ type: 'text', text: 'Moved cursor.' }] };
    }

    case 'left_click_drag': {
      const end = scale(args.coordinate);
      const start = args.start_coordinate ? scale(args.start_coordinate) : undefined;
      const from = start ? { x: start[0], y: start[1] } : undefined;
      await exec.drag(from, { x: end[0], y: end[1] });
      return { content: [{ type: 'text', text: 'Dragged.' }] };
    }

    case 'left_mouse_down': {
      await exec.mouseDown();
      return { content: [{ type: 'text', text: 'Mouse down.' }] };
    }

    case 'left_mouse_up': {
      await exec.mouseUp();
      return { content: [{ type: 'text', text: 'Mouse up.' }] };
    }

    case 'cursor_position': {
      const pos = await exec.getCursorPosition();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ x: pos.x, y: pos.y }),
        }],
      };
    }

    case 'zoom': {
      const [rx, ry, rw, rh] = args.region || [0, 0, 100, 100];
      const dims = lastDims();
      let regionLogical;
      if (coordinateMode === 'normalized' && dims) {
        regionLogical = {
          x: Math.round(rx * dims.displayWidth),
          y: Math.round(ry * dims.displayHeight),
          w: Math.round(rw * dims.displayWidth),
          h: Math.round(rh * dims.displayHeight),
        };
      } else if (dims && dims.width > 0 && dims.height > 0) {
        const sx = dims.displayWidth / dims.width;
        const sy = dims.displayHeight / dims.height;
        regionLogical = {
          x: Math.round(rx * sx),
          y: Math.round(ry * sy),
          w: Math.round(rw * sx),
          h: Math.round(rh * sy),
        };
      } else {
        regionLogical = { x: rx, y: ry, w: rw, h: rh };
      }
      const result = await exec.zoom(
        regionLogical,
        getAllowedBundleIds(),
        getDisplayId(),
      );
      return {
        content: [
          {
            type: 'image',
            data: result.base64,
            mimeType: 'image/jpeg',
          },
          {
            type: 'text',
            text: JSON.stringify({ width: result.width, height: result.height }),
          },
        ],
      };
    }

    case 'wait': {
      const seconds = args.duration || 1;
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      return { content: [{ type: 'text', text: `Waited ${seconds}s.` }] };
    }

    case 'read_clipboard': {
      const flags = ctx.getGrantFlags();
      if (!flags.clipboardRead) {
        return {
          content: [{ type: 'text', text: 'Clipboard read access not granted.' }],
          isError: true,
        };
      }
      const text = await exec.readClipboard();
      return { content: [{ type: 'text', text: text || '' }] };
    }

    case 'write_clipboard': {
      const flags = ctx.getGrantFlags();
      if (!flags.clipboardWrite) {
        return {
          content: [{ type: 'text', text: 'Clipboard write access not granted.' }],
          isError: true,
        };
      }
      await exec.writeClipboard(args.text);
      return { content: [{ type: 'text', text: 'Written to clipboard.' }] };
    }

    case 'open_application': {
      await exec.openApp(args.bundle_id);
      return { content: [{ type: 'text', text: `Opened ${args.bundle_id}.` }] };
    }

    case 'list_granted_applications': {
      const apps = ctx.getAllowedApps();
      if (apps.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No applications have been granted access yet. Use request_access to get permission.',
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(apps.map(a => ({
            bundleId: a.bundleId,
            displayName: a.displayName,
          }))),
        }],
      };
    }

    case 'request_access': {
      const appNames = args.app_names || [];
      // Resolve app names to installed apps
      let installed;
      try {
        installed = await exec.listInstalledApps();
      } catch {
        installed = [];
      }

      const resolvedApps = appNames.map(name => {
        const match = installed.find(a =>
          a.displayName.toLowerCase() === name.toLowerCase() ||
          a.bundleId.toLowerCase() === name.toLowerCase()
        );
        return {
          requestedName: name,
          resolved: match ? {
            bundleId: match.bundleId,
            displayName: match.displayName,
            path: match.path,
          } : undefined,
        };
      });

      const response = await ctx.onPermissionRequest({
        apps: resolvedApps,
        requestedFlags: ctx.getGrantFlags(),
      });

      // Apply the response: update allowed apps and flags
      const currentApps = ctx.getAllowedApps();
      const merged = [...currentApps];
      for (const g of (response.granted || [])) {
        if (!merged.find(a => a.bundleId === g.bundleId)) {
          merged.push(g);
        }
      }
      ctx.onAllowedAppsChanged(merged, response.flags || ctx.getGrantFlags());

      const grantedNames = (response.granted || []).map(a => a.displayName || a.bundleId);
      const deniedNames = (response.denied || []).map(a => a.requestedName || a.bundleId || 'unknown');

      let msg = '';
      if (grantedNames.length > 0) {
        msg += `Access granted for: ${grantedNames.join(', ')}.`;
      }
      if (deniedNames.length > 0) {
        msg += (msg ? ' ' : '') + `Access denied for: ${deniedNames.join(', ')}.`;
      }
      if (!msg) {
        msg = 'Access request processed.';
      }

      return { content: [{ type: 'text', text: msg }] };
    }

    case 'switch_display': {
      const name = args.display_name;
      if (name === 'auto') {
        ctx.onDisplayPinned(undefined);
        return { content: [{ type: 'text', text: 'Switched to auto display resolution.' }] };
      }
      // Try to find the display by name
      let displays;
      try {
        displays = await exec.listDisplays();
      } catch {
        displays = [];
      }
      const match = displays.find(d =>
        String(d.displayId) === name ||
        (d.name && d.name.toLowerCase().includes(name.toLowerCase()))
      );
      if (match) {
        ctx.onDisplayPinned(match.displayId);
        return {
          content: [{
            type: 'text',
            text: `Switched to display ${match.displayId}${match.name ? ` (${match.name})` : ''}.`,
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Display "${name}" not found. Available: ${displays.map(d => d.displayId).join(', ')}`,
        }],
        isError: true,
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}

// ── MCP Server factory ──────────────────────────────────────────────────────

function createComputerUseMcpServer(adapter, coordinateMode) {
  const server = new Server(
    { name: adapter.serverName || 'computer-use', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (adapter.isDisabled && adapter.isDisabled()) {
      return { tools: [] };
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    if (adapter.logger) {
      adapter.logger.debug('CallTool %s %j', name, toolArgs);
    }
    // The MCP server's CallTool handler is a stub — real dispatch goes
    // through wrapper.tsx's .call() override via bindSessionContext.
    // This handler exists for the standalone subprocess entrypoint.
    return {
      content: [{
        type: 'text',
        text: `Tool ${name} called via MCP server. Use bindSessionContext for full orchestration.`,
      }],
    };
  });

  return server;
}

// ── Session context binding ─────────────────────────────────────────────────

/**
 * Bind a session context to a host adapter, returning a tool dispatch function.
 *
 * This is the core orchestration entry point. The returned dispatch function
 * wraps every tool call with:
 *   - Lock checking/acquisition (cross-session mutex)
 *   - Permission verification (app allowlist + grant flags)
 *   - TCC (macOS Accessibility/Screen Recording) checks
 *   - Coordinate scaling (model coords → display coords)
 *   - Hide-before-action (minimize non-allowed apps)
 *   - Display resolution (multi-monitor targeting)
 *   - Screenshot dimension stashing (for coordinate scaling)
 *
 * @param {ComputerUseHostAdapter} adapter
 * @param {string} coordinateMode - 'pixels' or 'normalized'
 * @param {ComputerUseSessionContext} ctx
 * @returns {(toolName: string, args: unknown) => Promise<CuCallToolResult>}
 */
function bindSessionContext(adapter, coordinateMode, ctx) {
  return async function dispatch(toolName, args) {
    const toolArgs = args || {};
    try {
      const result = await handleToolCall(
        adapter,
        toolName,
        toolArgs,
        coordinateMode,
        ctx,
      );
      return {
        content: result.content || [],
        isError: result.isError || false,
        telemetry: result.telemetry,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (adapter.logger) {
        adapter.logger.error('Tool %s failed: %s', toolName, message);
      }
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
        telemetry: { error_kind: 'exception' },
      };
    }
  };
}

// ── Grant flags ─────────────────────────────────────────────────────────────

const { DEFAULT_GRANT_FLAGS } = require('./types.js');

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  API_RESIZE_PARAMS,
  targetImageSize,
  buildComputerUseTools,
  createComputerUseMcpServer,
  bindSessionContext,
  DEFAULT_GRANT_FLAGS,
};
