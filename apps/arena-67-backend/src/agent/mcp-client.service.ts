import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDef } from './reasoning.service';

/** Synthetic tool that lets the model read MCP resources by URI. */
export const READ_RESOURCE_TOOL = 'read_mcp_resource';

/** Header the MCP server reads the per-turn user token from. */
const USER_HEADER = 'x-arena-user';

/** What one chat turn works with: the tools, and a way to call them. */
export interface McpSession {
  tools: ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * Opens an MCP session for one user, for one chat turn — grape's
 * `withUserSession` model.
 *
 * This replaced a single long-lived connection. That was fine while every
 * tool was public research, but the account tools act on a specific user's
 * wallet and memory, so the MCP server has to know whose turn it is. The user
 * token rides in a header on this session's transport; the MCP server bakes
 * it into its API client; the backend verifies it. At no point does it pass
 * through anything the model writes.
 *
 * A session per turn costs one extra round trip to list tools. That is the
 * price of the identity being unforgeable, and it also means a restarted MCP
 * server is simply picked up on the next turn with nothing to reconnect.
 */
@Injectable()
export class McpClientService {
  private readonly log = new Logger(McpClientService.name);
  /** Last tool list seen, for the status endpoint. Not used to make calls. */
  private lastTools: string[] = [];
  private lastResources: string[] = [];
  private lastError: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async withUserSession<T>(
    userToken: string,
    operation: (session: McpSession) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: 'arena-67-backend', version: '1.0.0' });
    const headers: Record<string, string> = { [USER_HEADER]: userToken };
    const mcpToken = this.config.get<string>('MCP_TOKEN');
    if (mcpToken) headers['authorization'] = `Bearer ${mcpToken}`;
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.getOrThrow<string>('MCP_URL')),
      { requestInit: { headers } },
    );

    try {
      await client.connect(transport);
      const [listedTools, listedResources] = await Promise.all([
        client.listTools(),
        // A server may legitimately expose no resources; not a failure.
        client.listResources().catch(() => ({ resources: [] })),
      ]);

      const names = new Set(listedTools.tools.map((t) => t.name));
      const resources = (listedResources.resources ?? []).map((r) => ({
        uri: r.uri,
        description: r.description ?? r.name ?? r.uri,
      }));

      const tools: ToolDef[] = listedTools.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<
            string,
            unknown
          >,
        },
      }));

      // Resources become one synthetic tool whose `uri` enum is the live
      // list, so a new resource on the server is readable without a code
      // change here — and a URI that is not on the list cannot be asked for.
      if (resources.length > 0) {
        tools.push({
          type: 'function',
          function: {
            name: READ_RESOURCE_TOOL,
            description: 'Read an Arena 67 resource by its URI.',
            parameters: {
              type: 'object',
              properties: {
                uri: {
                  type: 'string',
                  enum: resources.map((r) => r.uri),
                  description: resources.map((r) => `${r.uri}: ${r.description}`).join('\n'),
                },
              },
              required: ['uri'],
              additionalProperties: false,
            },
          },
        });
      }

      this.lastTools = tools.map((t) => t.function.name);
      this.lastResources = resources.map((r) => r.uri);
      this.lastError = null;

      return await operation({
        tools,
        call: (name, args) => this.call(client, names, resources, name, args),
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Runs one tool and returns its text. Errors come back as text rather than
   * thrown: "that is not a token" is something the model can recover from,
   * whereas an exception ends the turn with nothing to say.
   */
  private async call(
    client: Client,
    names: Set<string>,
    resources: Array<{ uri: string }>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (name === READ_RESOURCE_TOOL) {
      const uri = typeof args.uri === 'string' ? args.uri : '';
      if (!resources.some((r) => r.uri === uri)) {
        return `Tool error: unknown resource "${uri}".`;
      }
      try {
        const result = await client.readResource({ uri });
        const text = (result.contents ?? [])
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n');
        return text || '(the resource returned nothing)';
      } catch (err) {
        return `Tool error: ${(err as Error).message}`;
      }
    }

    // A hallucinated name is refused here rather than sent upstream, so it
    // comes back as a correctable message instead of a protocol error.
    if (!names.has(name)) {
      return `Tool error: no such tool "${name}". Available: ${[...names].join(', ')}`;
    }

    try {
      const result = await client.callTool({ name, arguments: args });
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n');
      return text || '(the tool returned nothing)';
    } catch (err) {
      this.log.warn(`tool ${name} failed: ${(err as Error).message}`);
      return `Tool error: ${(err as Error).message}`;
    }
  }

  status() {
    return {
      tools: this.lastTools,
      resources: this.lastResources,
      lastError: this.lastError,
    };
  }
}
