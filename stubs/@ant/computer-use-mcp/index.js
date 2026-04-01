/**
 * Stub @ant/computer-use-mcp — JS orchestration layer for computer use.
 * Provides tool definitions, MCP server creation, and image resize utilities.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// Anthropic computer use API image constraints
const API_RESIZE_PARAMS = {
  maxLongSide: 1280,
  maxShortSide: 768,
  maxPixels: 1280 * 768,
};

function targetImageSize(physW, physH, params) {
  const p = params || API_RESIZE_PARAMS;
  const longSide = Math.max(physW, physH);
  const shortSide = Math.min(physW, physH);
  if (longSide <= p.maxLongSide && shortSide <= p.maxShortSide) {
    return [physW, physH];
  }
  const scaleLong = p.maxLongSide / longSide;
  const scaleShort = p.maxShortSide / shortSide;
  const scale = Math.min(scaleLong, scaleShort);
  return [Math.round(physW * scale), Math.round(physH * scale)];
}

const TOOL_DEFS = [
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current screen or a specific app.',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'App to screenshot. If omitted, captures the full screen.' },
        display_id: { type: 'number', description: 'Display to capture (for multi-monitor setups).' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click at the specified coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] coordinates.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button.' },
      },
      required: ['coordinate'],
    },
  },
  {
    name: 'double_click',
    description: 'Double-click at the specified coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['coordinate'],
    },
  },
  {
    name: 'type',
    description: 'Type text at the current cursor position.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'key',
    description: 'Press a key or key combination (e.g. "return", "command+c").',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Key or key combination.' },
        repeat: { type: 'number', description: 'Number of times to repeat.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll at the specified coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', description: 'Scroll amount in clicks.' },
      },
      required: ['coordinate', 'scroll_direction', 'scroll_amount'],
    },
  },
  {
    name: 'drag',
    description: 'Drag from one coordinate to another.',
    inputSchema: {
      type: 'object',
      properties: {
        start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['start_coordinate', 'coordinate'],
    },
  },
  {
    name: 'move',
    description: 'Move the mouse to the specified coordinates without clicking.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['coordinate'],
    },
  },
  {
    name: 'request_access',
    description: 'Request permission to use computer tools for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        app_names: { type: 'array', items: { type: 'string' }, description: 'Apps to request access for.' },
        grant_flags: {
          type: 'object',
          properties: {
            systemKeyCombos: { type: 'boolean' },
          },
        },
      },
      required: ['app_names'],
    },
  },
];

function buildComputerUseTools(capabilities, coordinateMode, installedAppNames) {
  const tools = TOOL_DEFS.map(t => ({ ...t }));
  // Add coordinate mode info to descriptions
  const coordDesc = coordinateMode === 'normalized'
    ? 'Coordinates are normalized [0,1].'
    : 'Coordinates are in pixels.';
  for (const tool of tools) {
    if (tool.inputSchema?.properties?.coordinate) {
      tool.description += ` ${coordDesc}`;
    }
  }
  // Add installed app names to request_access description
  if (installedAppNames && installedAppNames.length > 0) {
    const ra = tools.find(t => t.name === 'request_access');
    if (ra) {
      ra.description += `\n\nInstalled apps: ${installedAppNames.join(', ')}`;
    }
  }
  return tools;
}

function createComputerUseMcpServer(adapter, coordinateMode) {
  const server = new Server(
    { name: 'computer-use', version: '0.1.3' },
    { capabilities: { tools: {}, logging: {} } },
  );

  // CallTool handler — delegates to the adapter
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await adapter.executor[name]?.(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result ?? 'ok') }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

module.exports = {
  buildComputerUseTools,
  createComputerUseMcpServer,
  API_RESIZE_PARAMS,
  targetImageSize,
};
