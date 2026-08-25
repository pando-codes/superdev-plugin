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
  /**
   * Whether this tool still runs on a server that never got a credential.
   *
   * Almost nothing may set this. The unconfigured short-circuit in server.ts is
   * what guarantees an inert server makes NO request — the property the whole
   * unconfigured path rests on — so an exemption is only safe for a tool that
   * touches neither the client nor the network. `catalog_doctor` is the case it
   * exists for, and it is the case that most needs it: a diagnostic that
   * refuses to run until the thing it diagnoses is fixed is not a diagnostic.
   */
  readonly worksUnconfigured?: boolean;
  readonly handler: (client: CatalogClient, args: any) => Promise<unknown>;
}
