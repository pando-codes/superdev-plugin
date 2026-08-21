/**
 * Builds a configured MCP server over a catalogue API client.
 *
 * Transport-agnostic on purpose: stdio ships now and remote HTTP is a later
 * milestone, and the difference between them should be an entrypoint, not a
 * second copy of every tool. Everything transport-specific lives in stdio.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, type CatalogClient } from "./client.ts";
import { schemaResources } from "./resources.ts";
import { allTools } from "./tools/index.ts";

/**
 * Turns a failure into a tool result the model can act on.
 *
 * `isError: true` rather than a thrown exception, because a thrown error is a
 * PROTOCOL failure — it tells the client the tool broke, not that the request
 * was refused. An API 403 is a normal, informative outcome: the catalogue works
 * exactly as designed and this key may not do that. The distinction decides
 * whether an agent adjusts or retries blindly.
 *
 * The API's message is passed through verbatim. It was written to be actionable
 * ("this operation requires product-manager; this key carries quality-assurance")
 * and any rewording here would only lose information.
 */
function toolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  if (error instanceof ApiError) {
    const detail = error.details ? `\n\n${JSON.stringify(error.details, null, 2)}` : "";
    return {
      content: [{ type: "text", text: `${error.code} (HTTP ${error.status}): ${error.message}${detail}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export interface ServerOptions {
  /**
   * The tools to register. Omitted registers every tool.
   *
   * This is a SURFACE decision, never an authority one — see roles.ts. The
   * database refuses what a key may not do regardless of what is registered
   * here, and nothing downstream of this parameter checks a role.
   */
  readonly toolNames?: ReadonlySet<string>;
  /** One line for the instructions, saying why the menu looks like it does. */
  readonly surfaceBasis?: string;
  /** The identity this server's claims will be recorded under. */
  readonly agentId?: string;
  /**
   * Set when no configuration was found. Every tool is still REGISTERED, and
   * every call returns this text instead of reaching the catalogue.
   *
   * WHY A SERVER THAT CANNOT WORK STARTS ANYWAY
   *
   * The alternative is what this used to do: exit at startup. To the person who
   * has just installed the plugin that is indistinguishable from a plugin that
   * is broken — the catalog_* tools are simply not in the session, the reason
   * is a stderr line in a log they have no reason to open, and the composed
   * instructions that say exactly which three files were consulted are thrown
   * away by the only process that had them. Registering the tools and answering
   * every call with those instructions puts the fix in front of the one party
   * who can apply it.
   *
   * This is not a way to work unconfigured. No request is made, nothing is
   * cached, and every call is `isError` — the server is inert until a key
   * exists. It widens nothing: an unconfigured server holds no key, so there is
   * no authority here for a surface to overstate.
   */
  readonly unconfigured?: string;
}

export function createMcpServer(client: CatalogClient, options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "pando-catalog", version: "0.1.0" },
    {
      instructions:
        "The Pando delivery-object catalogue: Capability -> Feature -> {User Story, " +
        "Acceptance Criterion}, and whether those capabilities currently work.\n\n" +
        "Two things to know before writing anything. First, the database enforces SHAPE, not " +
        "QUALITY — a capability whose scope_boundary reads 'stuff' satisfies every constraint " +
        "in the schema. The quality bar lives in each write tool's description; read it. " +
        "Second, authority is per-role: your key carries one pando_role, and a refusal is a " +
        "normal answer rather than a fault. Call catalog_whoami if a write is refused.\n\n" +
        "Records are addressed by key, never by id. Capability and feature keys are unique " +
        "PER PRODUCT; story and acceptance-criterion keys are global.\n\n" +
        "TO GET WORK, call catalog_claim_work. Work is addressed to a ROLE — yours — and " +
        "arrives as a brief: why it exists, how to do it, the stories that explain it, and " +
        "the acceptance criteria it will be judged against. A claim is a LEASE that " +
        "expires: heartbeat while you work, and treat a lost lease as a full stop. An " +
        "empty answer means this role's queue is empty, which is success, not failure.\n\n" +
        (options.unconfigured !== undefined
          ? "THIS SERVER HOLDS NO KEY YET. Every tool below is listed, and every one of them " +
            "returns setup instructions instead of doing anything, because no api_url and " +
            "api_key could be found. Nothing can be read or written until that is fixed. Call " +
            "a tool if you want the instructions, and show them to the user verbatim — they " +
            "name the exact files that were consulted, and only the user can act on them."
          : options.surfaceBasis
            ? `The tools below are the ones this key can actually use — the menu is ${options.surfaceBasis}. ` +
              "A tool you cannot see is one the database would refuse, not one that is missing."
            : "") +
        (options.agentId ? `\n\nClaims from this session are recorded as "${options.agentId}".` : ""),
    },
  );

  const registering = options.toolNames
    ? allTools.filter((tool) => options.toolNames!.has(tool.name))
    : allTools;

  for (const tool of registering) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args: any) => {
        // Before the client is touched at all: an unconfigured server never
        // makes a request, so there is no half-configured call to go wrong.
        if (options.unconfigured !== undefined) {
          return {
            content: [{ type: "text" as const, text: options.unconfigured }],
            isError: true as const,
          };
        }
        try {
          const result = await tool.handler(client, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  for (const resource of schemaResources) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: "application/json" },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(resource.schema, null, 2),
          },
        ],
      }),
    );
  }

  return server;
}
