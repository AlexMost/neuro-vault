import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistration } from './tool-registration.js';

/**
 * Answers `tools/call` straight from each registration's handler, so the
 * arguments reach the registration gate as the client sent them.
 *
 * `McpServer.registerTool` keeps advertising each tool — its `tools/list`
 * converts `spec.inputSchema` to JSON Schema — but its own `tools/call`
 * handler parses the arguments against that same schema first and answers a
 * failure as `-32602` "Input validation error" with zod's text, so the gate's
 * `INVALID_PARAMS` envelope never reached a client. This replaces that handler;
 * run it after the tools are registered, since the first `registerTool`
 * installs the SDK's. What the SDK handler did besides validating does not
 * apply here: no tool declares an `outputSchema`, is disabled, or runs as a task.
 */
export function dispatchToolCallsToGate(
  server: McpServer['server'],
  tools: readonly ToolRegistration[],
): void {
  const handlers = new Map(tools.map((tool) => [tool.name, tool.handler]));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers.get(request.params.name);
    if (handler === undefined) {
      // The SDK's answer for an unknown tool, word for word.
      const error = new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    return handler(request.params.arguments);
  });
}
