/**
 * Stub implementation of @ant/computer-use-mcp.
 *
 * Provides the JS orchestration layer for Anthropic computer use: tool
 * definitions, MCP server factory, and image-resize helpers. Native work
 * (screenshots, input) lives in @ant/computer-use-swift and
 * @ant/computer-use-input; this package wires them into an MCP server.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// ── Resize constants ────────────────────────────────────────────────────────

/**
 * Anthropic computer-use API resize parameters. The API scales screenshots so
 * the longest side fits within these bounds. Matching them client-side avoids
 * a server-side resize and keeps coordinate mapping 1:1.
 */
const API_RESIZE_PARAMS = Object.freeze({
  maxLongSide: 1280,
  maxShortSide: 800,
});

/**
 * Scale physical pixel dimensions down to fit within API_RESIZE_PARAMS,
 * preserving aspect ratio. Returns [targetWidth, targetHeight].
 *
 * If the image already fits, returns the original dimensions unchanged.
 */
function targetImageSize(physW, physH, resizeParams) {
  const params = resizeParams || API_RESIZE_PARAMS;
  const longSide = Math.max(physW, physH);
  const shortSide = Math.min(physW, physH);

  if (longSide <= params.maxLongSide && shortSide <= params.maxShortSide) {
    return [physW, physH];
  }

  // Scale by whichever constraint is tighter.
  const scaleLong = params.maxLongSide / longSide;
  const scaleShort = params.maxShortSide / shortSide;
  const scale = Math.min(scaleLong, scaleShort);

  return [Math.round(physW * scale), Math.round(physH * scale)];
}

// ── Tool definitions ────────────────────────────────────────────────────────

/**
 * Coordinate-mode description fragment. When mode is 'normalized', coordinates
 * are 0..1 floats; when 'pixels', they are absolute pixel values scaled to
 * the screenshot dimensions returned with each screenshot.
 */
function coordDesc(coordinateMode) {
  if (coordinateMode === 'normalized') {
    return 'Coordinates are normalized floats in [0, 1] relative to screenshot dimensions.';
  }
  return 'Coordinates are in pixels, matching the screenshot dimensions returned with each screenshot.';
}

function intProp(description) {
  return { type: 'integer', description };
}

function numProp(description) {
  return { type: 'number', description };
}

function strProp(description) {
  return { type: 'string', description };
}

/**
 * Build the MCP tool definitions array for the computer-use tool set.
 *
 * @param {object} capabilities - Host capabilities (platform, screenshotFiltering, etc.)
 * @param {string} coordinateMode - 'pixels' or 'normalized'
 * @param {string[]} [installedAppNames] - Optional list of installed app names for request_access description
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
function buildComputerUseTools(capabilities, coordinateMode, installedAppNames) {
  const coordNote = coordDesc(coordinateMode);
  const isNormalized = coordinateMode === 'normalized';
  const coordType = isNormalized ? 'number' : 'integer';

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
      name: 'click',
      description:
        'Click at the specified coordinates. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: coordType, description: 'X coordinate' },
          y: { type: coordType, description: 'Y coordinate' },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Mouse button (default: left)',
          },
          count: {
            type: 'integer',
            enum: [1, 2, 3],
            description: 'Click count: 1 = single, 2 = double, 3 = triple (default: 1)',
          },
          modifiers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Modifier keys to hold during click (e.g. ["shift", "command"])',
          },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'double_click',
      description:
        'Double-click at the specified coordinates. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: coordType, description: 'X coordinate' },
          y: { type: coordType, description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'right_click',
      description:
        'Right-click at the specified coordinates to open a context menu. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: coordType, description: 'X coordinate' },
          y: { type: coordType, description: 'Y coordinate' },
        },
        required: ['x', 'y'],
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
          key: strProp(
            'Key or key combination in xdotool format (e.g. "Return", "command+c", "ctrl+shift+a")',
          ),
          repeat: intProp('Number of times to repeat the key press (default: 1)'),
        },
        required: ['key'],
      },
    },
    {
      name: 'scroll',
      description:
        'Scroll at the specified coordinates. Positive dy scrolls down, negative scrolls up. ' +
        'Positive dx scrolls right, negative scrolls left. ' +
        coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: coordType, description: 'X coordinate to scroll at' },
          y: { type: coordType, description: 'Y coordinate to scroll at' },
          dx: intProp('Horizontal scroll amount (positive = right, negative = left)'),
          dy: intProp('Vertical scroll amount (positive = down, negative = up)'),
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'drag',
      description:
        'Drag from one position to another. Holds left mouse button at the start position, ' +
        'moves to the end position, then releases. ' +
        coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: coordType, description: 'Start X coordinate' },
          startY: { type: coordType, description: 'Start Y coordinate' },
          endX: { type: coordType, description: 'End X coordinate' },
          endY: { type: coordType, description: 'End Y coordinate' },
        },
        required: ['startX', 'startY', 'endX', 'endY'],
      },
    },
    {
      name: 'move',
      description:
        'Move the mouse cursor to the specified coordinates without clicking. ' + coordNote,
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: coordType, description: 'X coordinate' },
          y: { type: coordType, description: 'Y coordinate' },
        },
        required: ['x', 'y'],
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
  ];

  return tools;
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

// ── MCP Server factory ──────────────────────────────────────────────────────

/**
 * Create an MCP Server wired to the provided host adapter. Registers ListTools
 * and CallTool handlers that delegate to the adapter's executor.
 *
 * @param {object} adapter - ComputerUseHostAdapter with executor, logger, etc.
 * @param {string} coordinateMode - 'pixels' or 'normalized'
 * @returns {Server}
 */
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
    const { name, arguments: args } = request.params;

    if (adapter.logger) {
      adapter.logger.debug('CallTool %s %j', name, args);
    }

    try {
      const result = await dispatchToolCall(adapter, name, args || {}, coordinateMode);
      return {
        content: Array.isArray(result) ? result : [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (adapter.logger) {
        adapter.logger.error('CallTool %s failed: %s', name, message);
      }
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Route a tool call to the appropriate executor method. Minimal stub — just
 * enough for the server to start and accept calls; real dispatch logic lives
 * in the full package.
 */
async function dispatchToolCall(adapter, toolName, args, _coordinateMode) {
  const exec = adapter.executor;

  switch (toolName) {
    case 'screenshot': {
      const result = await exec.screenshot({
        allowedBundleIds: [],
      });
      return [
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
      ];
    }
    case 'click':
      await exec.click(
        args.x,
        args.y,
        args.button || 'left',
        args.count || 1,
        args.modifiers,
      );
      return { ok: true };
    case 'double_click':
      await exec.click(args.x, args.y, 'left', 2);
      return { ok: true };
    case 'right_click':
      await exec.click(args.x, args.y, 'right', 1);
      return { ok: true };
    case 'type':
      await exec.type(args.text, { viaClipboard: false });
      return { ok: true };
    case 'key':
      await exec.key(args.key, args.repeat);
      return { ok: true };
    case 'scroll':
      await exec.scroll(args.x, args.y, args.dx || 0, args.dy || 0);
      return { ok: true };
    case 'drag':
      await exec.drag(
        { x: args.startX, y: args.startY },
        { x: args.endX, y: args.endY },
      );
      return { ok: true };
    case 'move':
      await exec.moveMouse(args.x, args.y);
      return { ok: true };
    case 'request_access':
      // Access approval is handled by the host (wrapper.tsx). Return success
      // so the model knows the call was received.
      return { ok: true, message: 'Access request received.' };
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── Session context binding ─────────────────────────────────────────────────

/**
 * Bind a session context to a host adapter, returning a tool dispatch function.
 *
 * @param {object} adapter - ComputerUseHostAdapter
 * @param {string} coordinateMode - 'pixels' or 'normalized'
 * @param {object} ctx - ComputerUseSessionContext with callbacks
 * @returns {(toolName: string, args: unknown) => Promise<CuCallToolResult>}
 */
function bindSessionContext(adapter, coordinateMode, ctx) {
  return async function dispatch(toolName, args) {
    return dispatchToolCall(adapter, toolName, args || {}, coordinateMode);
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
