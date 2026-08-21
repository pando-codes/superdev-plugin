import type { ZodRawShape } from "zod";
import type { CatalogClient } from "../client.ts";

/**
 * A tool as DATA, not as a registration call.
 *
 * The plan commits to stdio now and remote HTTP later. Keeping tools as plain
 * values means that second transport is a new entrypoint over the same array
 * rather than a second copy of every tool — and it means the suite can invoke a
 * handler directly, without standing up a protocol session, to test what the
 * tool actually does.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ZodRawShape;
  /** MCP hints. readOnly matters: it tells a client this tool cannot change state. */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly handler: (client: CatalogClient, args: any) => Promise<unknown>;
}
