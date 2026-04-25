import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

export interface ToolRegistration {
  name: RegisterToolArgs[0];
  spec: RegisterToolArgs[1];
  handler: (args: unknown) => Promise<CallToolResult>;
}
