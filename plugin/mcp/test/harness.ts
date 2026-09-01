/**
 * A real MCP session over a RECORDING fetch, with no API and no database.
 *
 * WHY THIS IS NOT THE SUITE THIS PACKAGE USED TO HAVE
 *
 * When the server lived alongside the API, its tests pointed the BacklogClient's
 * injectable fetch straight at the Hono app in-process, so every call traversed
 * the genuine auth middleware, the genuine per-role pools, and the genuine RLS
 * policies. That suite still exists and still runs — it lives in
 * apps/backend/test/, with the API and the migrations it asserts against.
 *
 * The two halves share a repository again, which does NOT make duplicating it
 * here a good idea: this package must be testable without a database, because
 * it ships to machines that have no access to one. The seam is the point, not
 * the directory.
 *
 * What is left here is the half that is genuinely this package's own: does a
 * tool call turn into the RIGHT REQUEST. That is the seam a move like this can
 * actually break — a mistyped path, a renamed field, a link kind wired to the
 * wrong endpoint — and none of it needs a server to answer, only a record of
 * what was sent.
 *
 * The line to hold: assertions here are about the REQUEST. Nothing here may
 * assert what the backlog would answer, because nothing here knows.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BacklogClient } from "../src/client.ts";
import { createMcpServer, type ServerOptions } from "../src/server.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Record<string, string>;
  readonly body: any;
}

export interface StubHarness {
  readonly client: Client;
  readonly sent: RecordedRequest[];
  /** The single request a test made. Fails loudly if it made none, or several. */
  only(): RecordedRequest;
  /** Queue the status and JSON body the next request should receive. */
  reply(status: number, body: unknown): void;
  close(): Promise<void>;
}

export const TEST_KEY = "pcat_live_0000000000000000000000000000000000000000";

/** The identity this stub session claims work under, unless a call overrides it. */
export const TEST_AGENT = "stub-agent";

/**
 * `options` are handed to createMcpServer untouched, so a test can stand up the
 * same session the entrypoint would in a state other than the happy one — a
 * narrowed surface, or a server that never got a key. The recording fetch stays
 * either way, which is what lets a test assert that NO request was made.
 */
export async function startStub(options: ServerOptions = {}): Promise<StubHarness> {
  const sent: RecordedRequest[] = [];
  const queued: Array<{ status: number; body: unknown }> = [];

  const recordingFetch: typeof globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    sent.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.search,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const next = queued.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const server = createMcpServer(
    new BacklogClient({
      baseUrl: "http://backlog.test",
      apiKey: TEST_KEY,
      agentId: TEST_AGENT,
      fetch: recordingFetch,
    }),
    options,
  );

  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    sent,
    only() {
      if (sent.length !== 1) {
        throw new Error(`expected exactly one request, saw ${sent.length}`);
      }
      return sent[0]!;
    },
    reply(status, body) {
      queued.push({ status, body });
    },
    async close() {
      await client.close();
    },
  };
}

/** Unwraps a tool result into its text, with the isError flag alongside. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; json: any }> {
  const result: any = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c: any) => c.text ?? "").join("\n");
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}
