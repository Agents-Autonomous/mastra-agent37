/**
 * A small typed client for the Agent37 Cloud REST API.
 *
 * Agent37 has no official TypeScript SDK (the `agent37` npm package is a
 * CLI), so this client covers the endpoints the sandbox provider needs on
 * both planes:
 *
 * - the Sandbox API at `https://api.agent37.com/v1` with `Authorization: Bearer`
 * - exec on the instance's own machine at `https://sandbox.agent37.app` with `X-Agent37-Key`
 *
 * The key is only ever sent in request headers; it is never logged or
 * included in error messages.
 */

import { Agent37ApiError, toApiError } from './errors';
import type {
  Agent37Backup,
  Agent37BackgroundExecResult,
  Agent37CreateInstanceParams,
  Agent37ExecParams,
  Agent37ExecResult,
  Agent37Instance,
  Agent37LifecycleAck,
  Agent37SignedUrl,
  Agent37UpdateInstanceParams,
} from './types';

export const DEFAULT_API_URL = 'https://api.agent37.com/v1';
export const DEFAULT_EXEC_URL = 'https://sandbox.agent37.app';

export interface Agent37ClientOptions {
  /** Workspace API key (`sk_live_...`). Defaults to the `AGENT37_API_KEY` environment variable. */
  apiKey?: string;
  /** Sandbox API base URL. Default: `https://api.agent37.com/v1`. */
  apiUrl?: string;
  /** Exec base URL. Default: `https://sandbox.agent37.app` (or `https://sandbox.{your-domain}` with a custom domain). */
  execUrl?: string;
  /** Custom fetch implementation, for tests or proxies. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** How many times to retry a request that failed with a documented transient error. Default: 4. */
  maxRetries?: number;
  /** Base delay for exponential backoff between retries, in ms. Default: 1000. */
  retryBaseDelayMs?: number;
}

interface RequestOptions {
  body?: unknown;
  /** Send to the exec plane with `X-Agent37-Key` instead of the Sandbox API. */
  execPlane?: boolean;
  /** Retry documented transient errors. Only for idempotent calls. */
  retry?: boolean;
  signal?: AbortSignal;
  /** Treat these statuses as success and return the parsed body. */
  okStatuses?: number[];
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Typed client for the Agent37 Cloud REST API. */
export class Agent37Client {
  readonly apiUrl: string;
  readonly execUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;

  constructor(options: Agent37ClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.AGENT37_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Agent37 API key is missing. Pass `apiKey` or set the AGENT37_API_KEY environment variable ' +
          '(create one at https://www.agent37.com/dashboard/cloud/api-keys).',
      );
    }
    this.#apiKey = apiKey;
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.execUrl = (options.execUrl ?? DEFAULT_EXEC_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxRetries = options.maxRetries ?? 4;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  // ---------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------

  /** `POST /v1/instances`. Resolves once the instance is `running`. Not retried: a retry could create a duplicate. */
  createInstance(params: Agent37CreateInstanceParams = {}, signal?: AbortSignal): Promise<Agent37Instance> {
    return this.request('POST', '/instances', { body: params, signal });
  }

  /** `GET /v1/instances/{id}`. Throws {@link Agent37ApiError} with `isNotFound` for unknown or deleted ids. */
  getInstance(id: string, signal?: AbortSignal): Promise<Agent37Instance> {
    return this.request('GET', `/instances/${encodeURIComponent(id)}`, { retry: true, signal });
  }

  /** `GET /v1/instances`, newest first. */
  async listInstances(signal?: AbortSignal): Promise<Agent37Instance[]> {
    const body = await this.request<{ data: Agent37Instance[] }>('GET', '/instances', { retry: true, signal });
    return body.data ?? [];
  }

  /** `PATCH /v1/instances/{id}`: name, metadata, env, auto-sleep, and network. */
  updateInstance(id: string, params: Agent37UpdateInstanceParams, signal?: AbortSignal): Promise<Agent37Instance> {
    return this.request('PATCH', `/instances/${encodeURIComponent(id)}`, { body: params, retry: true, signal });
  }

  /** `DELETE /v1/instances/{id}`. Resolves `false` when the instance was already gone. */
  async deleteInstance(id: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request('DELETE', `/instances/${encodeURIComponent(id)}`, { retry: true, signal });
      return true;
    } catch (error) {
      if (error instanceof Agent37ApiError && error.isNotFound) return false;
      throw error;
    }
  }

  /** `POST /v1/instances/{id}/stop`: halt the container. Disk is kept and billed; memory is lost. */
  stopInstance(id: string, signal?: AbortSignal): Promise<Agent37LifecycleAck> {
    return this.request('POST', `/instances/${encodeURIComponent(id)}/stop`, { retry: true, signal });
  }

  /**
   * `POST /v1/instances/{id}/start`: start a stopped instance or wake a sleeping one.
   * May answer `202` with `status: 'starting'` while a host move finishes.
   */
  startInstance(id: string, signal?: AbortSignal): Promise<Agent37LifecycleAck> {
    return this.request('POST', `/instances/${encodeURIComponent(id)}/start`, { retry: true, signal });
  }

  /** `POST /v1/instances/{id}/sleep`: checkpoint memory and processes, bill disk only. */
  sleepInstance(id: string, signal?: AbortSignal): Promise<Agent37LifecycleAck> {
    return this.request('POST', `/instances/${encodeURIComponent(id)}/sleep`, { retry: true, signal });
  }

  /** `POST /v1/instances/{id}/restart`. */
  restartInstance(id: string, signal?: AbortSignal): Promise<Agent37LifecycleAck> {
    return this.request('POST', `/instances/${encodeURIComponent(id)}/restart`, { retry: true, signal });
  }

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------

  /** `POST /v1/instances/{id}/backups`: take an on-demand backup (one per 15 minutes per instance). */
  createBackup(id: string, signal?: AbortSignal): Promise<Agent37Backup> {
    return this.request('POST', `/instances/${encodeURIComponent(id)}/backups`, { signal });
  }

  /** `GET /v1/instances/{id}/backups`. */
  async listBackups(id: string, signal?: AbortSignal): Promise<Agent37Backup[]> {
    const body = await this.request<{ data: Agent37Backup[] }>('GET', `/instances/${encodeURIComponent(id)}/backups`, {
      retry: true,
      signal,
    });
    return body.data ?? [];
  }

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------

  /** `POST /v1/instances/{id}/signed-url`: a browser-openable URL for one port. `ttlSeconds` is clamped to [60, 604800]. */
  createSignedUrl(id: string, port: number, ttlSeconds?: number, signal?: AbortSignal): Promise<Agent37SignedUrl> {
    return this.request('POST', `/instances/${encodeURIComponent(id)}/signed-url`, {
      body: { port, ...(ttlSeconds !== undefined && { ttl_seconds: ttlSeconds }) },
      retry: true,
      signal,
    });
  }

  /** The authenticated preview URL of a port: `https://{id}-{port}.agent37.app`. Requests need the `X-Agent37-Key` header. */
  previewUrl(id: string, port: number): string {
    return `https://${id}-${port}.agent37.app`;
  }

  // ---------------------------------------------------------------------------
  // Exec
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/instances/{id}/exec` on the instance's machine. Runs `sh -c`
   * and waits for the command (up to 15 minutes), unless `background` is set.
   * Wakes a sleeping instance first.
   *
   * Transient failures are retried only when the request carries a `name`,
   * which makes the resend return the first run's result instead of running
   * the command twice.
   */
  exec(
    id: string,
    params: Agent37ExecParams & { background: true },
    signal?: AbortSignal,
  ): Promise<Agent37BackgroundExecResult>;
  exec(id: string, params: Agent37ExecParams, signal?: AbortSignal): Promise<Agent37ExecResult>;
  exec(
    id: string,
    params: Agent37ExecParams,
    signal?: AbortSignal,
  ): Promise<Agent37ExecResult | Agent37BackgroundExecResult> {
    return this.request('POST', `/v1/instances/${encodeURIComponent(id)}/exec`, {
      body: params,
      execPlane: true,
      retry: params.name !== undefined,
      signal,
    });
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /** Send one request, retrying documented transient errors with exponential backoff when `retry` is set. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = options.execPlane ? `${this.execUrl}${path}` : `${this.apiUrl}${path}`;
    const headers: Record<string, string> = options.execPlane
      ? { 'X-Agent37-Key': this.#apiKey }
      : { Authorization: `Bearer ${this.#apiKey}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let error: unknown;
      try {
        const response = await this.#fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: options.signal,
        });
        if (response.ok) {
          const text = await response.text();
          return (text ? JSON.parse(text) : {}) as T;
        }
        error = await toApiError(response, method, path);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        error = err;
      }

      const retryable = error instanceof Agent37ApiError ? error.isRetryable : isNetworkError(error);
      if (!options.retry || !retryable || attempt >= this.#maxRetries) throw error;
      const retryAfterMs = error instanceof Agent37ApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0;
      await sleep(Math.max(retryAfterMs, this.#retryBaseDelayMs * 2 ** attempt));
    }
  }
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TypeError' || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message)
  );
}

export { Agent37ApiError } from './errors';
export type * from './types';
