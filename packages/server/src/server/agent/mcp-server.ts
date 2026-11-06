import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";
import type { Logger } from "pino";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}

// MCP 2026-07-28 clients open with a server/discover probe. This server speaks
// only the 2025 protocol revisions the SDK implements, so the transport rejects
// the probe with HTTP 400 and a JSON-RPC error, and the client falls back to a
// 2025-era initialize. That rejection is expected, not a transport failure.
const DISCOVERY_PROBE_METHOD = "server/discover";

/**
 * True only for the SDK transport's unsupported-protocol-version rejection of a
 * server/discover request, for the version that request sent. The SDK raises a
 * plain Error without a code, so this matches its exact message prefix. Every
 * other discovery failure, such as malformed JSON-RPC, stays a transport error.
 */
function isDeclinedDiscoveryProbe(input: {
  body: unknown;
  requestedVersion: string | string[] | undefined;
  err: Error;
}): boolean {
  const { body, requestedVersion, err } = input;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === DISCOVERY_PROBE_METHOD &&
    typeof requestedVersion === "string" &&
    err.message.startsWith(`Bad Request: Unsupported protocol version: ${requestedVersion} (`)
  );
}

/**
 * Serves one Agent MCP HTTP request statelessly: the transport is built for this
 * request and closed with its response, along with the per-request server.
 */
export async function serveStatelessAgentMcpRequest(input: {
  server: McpServer;
  req: IncomingMessage;
  res: ServerResponse;
  body: unknown;
  logger: Pick<Logger, "debug" | "error">;
}): Promise<void> {
  const { server, req, res, body, logger } = input;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
    // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
    enableDnsRebindingProtection: false,
  });
  Object.assign(transport, {
    onerror: (err: Error) => {
      if (
        isDeclinedDiscoveryProbe({
          body,
          requestedVersion: req.headers["mcp-protocol-version"],
          err,
        })
      ) {
        logger.debug({ err }, "Declined MCP discovery probe; client falls back to initialize");
        return;
      }
      logger.error({ err }, "Agent MCP transport error");
    },
  });
  await server.connect(transport);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req, res, body);
}
