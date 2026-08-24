/**
 * The catalogue API client.
 *
 * This is the ONLY thing in the MCP server that talks to anything, and it
 * carries an API key and nothing else. The MCP process deliberately holds no
 * database credential: it runs on a developer's machine inside a plugin, which
 * makes it the least trustworthy link in the chain. Compromising it yields a key
 * scoped to one pando_role and revocable with one UPDATE — not a Postgres login.
 *
 * `fetch` is injectable so the integration suite can point the client straight at
 * the Hono app in-process. That is not a mock: the same routes, the same pools,
 * the same database, the same RLS. It only removes the socket.
 */

import { recall, remember } from "./cache.ts";

export interface CatalogClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * Who this process is in the work queue, as distinct from which key it holds.
   * Sent as X-Pando-Agent-Id on every request; the catalogue records it as the
   * holder of any lease this client takes.
   */
  readonly agentId?: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Where the read cache lives, or undefined to keep no cache at all.
   *
   * A workspace directory rather than a flag: the cache is per-workspace for
   * the same reason the journal is, and a client built without one — every
   * client in the test suite, and the inert one an unconfigured server holds —
   * simply never reads or writes a file.
   */
  readonly cacheHome?: string;
}

export interface ApiResult<T = unknown> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T;
}

/**
 * A response the API refused. Carries the API's own message verbatim, because
 * that message is the actionable part — "this operation requires
 * product-manager; this key carries quality-assurance" is a sentence an agent
 * can do something with, and any rewording here would degrade it.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static from(status: number, body: any): ApiError {
    return new ApiError(
      status,
      typeof body?.error === "string" ? body.error : "unknown",
      typeof body?.message === "string" ? body.message : `request failed with ${status}`,
      body?.details,
    );
  }
}

export class CatalogClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #agentId: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #cacheHome: string | undefined;

  constructor(options: CatalogClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#agentId = options.agentId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#cacheHome = options.cacheHome;
  }

  /** The process-wide identity, for tools that want to report it. */
  get agentId(): string | undefined {
    return this.#agentId;
  }

  /**
   * `asAgent` overrides the identity for ONE request.
   *
   * It exists because several subagents inside a single Claude Code session
   * share one MCP server, and therefore one process identity. Without an
   * override they would all be the same agent to the catalogue — able to
   * finish, release, and heartbeat each other's work items by accident, which
   * is precisely the confusion the queue's lease exists to prevent. A subagent
   * that passes its own id gets its own claims.
   *
   * It is not a privilege mechanism. Every request still carries the same key
   * and therefore the same role; the identity distinguishes holders WITHIN that
   * authority, and the catalogue documents that boundary the same way.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    payload?: unknown,
    asAgent?: string,
  ): Promise<ApiResult<T>> {
    const agent = asAgent ?? this.#agentId;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        // The key travels in the Authorization header and nowhere else — never
        // a query parameter, which would land in access logs and referrers.
        authorization: `Bearer ${this.#apiKey}`,
        ...(agent === undefined ? {} : { "x-pando-agent-id": agent }),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = { error: "unreadable", message: `the API returned a non-JSON ${response.status}` };
    }

    if (!response.ok) throw ApiError.from(response.status, body);
    return { ok: true, status: response.status, body: body as T };
  }

  /**
   * A read, answered from the last good response when the catalogue cannot be
   * reached at all.
   *
   * ONLY when it cannot be reached. An `ApiError` is a real answer — 401, 403,
   * 404 — and serving a cached success in its place would tell an agent it may
   * read something the catalogue has just refused it. So the ApiError is
   * rethrown untouched and only a transport failure falls back.
   *
   * A cache miss rethrows too, and that is deliberate: "the catalogue is
   * unreachable" is a far better answer than an empty list, which an agent
   * would read as "there is nothing there".
   */
  async get<T = unknown>(path: string, asAgent?: string): Promise<ApiResult<T>> {
    try {
      const result = await this.request<T>("GET", path, undefined, asAgent);
      if (this.#cacheHome !== undefined) await remember(this.#cacheHome, path, result.body);
      return result;
    } catch (error) {
      if (this.#cacheHome === undefined || error instanceof ApiError) throw error;
      const cached = await recall(this.#cacheHome, path);
      if (cached === undefined) throw error;
      return { ok: true, status: 200, body: cached as T };
    }
  }
  post<T = unknown>(path: string, payload: unknown, asAgent?: string): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, payload, asAgent);
  }
  patch<T = unknown>(path: string, payload: unknown, asAgent?: string): Promise<ApiResult<T>> {
    return this.request<T>("PATCH", path, payload, asAgent);
  }
  delete<T = unknown>(path: string, payload: unknown, asAgent?: string): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path, payload, asAgent);
  }
}

/** Percent-encodes a path segment. Keys are user data and may not be assumed safe. */
export const seg = (value: string): string => encodeURIComponent(value);
