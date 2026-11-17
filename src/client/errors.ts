/**
 * Error raised for any non-2xx response from Agent37 Cloud.
 *
 * Both planes return a JSON `error` field: an object with a stable `code`
 * on the Sandbox API, or a flat string for transport errors on
 * `sandbox.agent37.app` (for example `{"error": "not_found"}`). Both shapes
 * normalize to {@link Agent37ApiError.code}.
 *
 * @see https://www.agent37.com/docs/agents-api/errors
 */
export class Agent37ApiError extends Error {
  override readonly name = 'Agent37ApiError';

  constructor(
    /** HTTP status code. */
    readonly status: number,
    /** Stable machine-readable error code, such as `not_found` or `try_again`. */
    readonly code: string,
    message: string,
    /** Raw failure output, present on some `provisioning_failed` errors. */
    readonly detail?: string,
    /** Seconds from a `Retry-After` header, when the response carried one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  /** The instance (or other resource) does not exist, was deleted, or belongs to another workspace. */
  get isNotFound(): boolean {
    return this.status === 404 || this.code === 'not_found';
  }

  /**
   * Transient conditions that the API documents as safe to retry: a sleep
   * checkpoint being written, a wake in progress, a busy exec slot, a host
   * move, or a backing service that is briefly unavailable.
   */
  get isRetryable(): boolean {
    return (
      this.code === 'try_again' ||
      this.code === 'wake_failed' ||
      this.code === 'wake_timeout' ||
      this.code === 'no_capacity' ||
      this.code === 'rate_limited' ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504
    );
  }
}

/** Parse an error response body into an {@link Agent37ApiError}. */
export async function toApiError(response: Response, method: string, path: string): Promise<Agent37ApiError> {
  const text = await response.text().catch(() => '');
  let code = `http_${response.status}`;
  let message = text.trim() || response.statusText || 'Request failed';
  let detail: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') {
      code = body.error;
      message = body.error;
    } else if (body.error && typeof body.error === 'object') {
      const err = body.error as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') message = err.message;
      if (typeof err.detail === 'string') detail = err.detail;
    }
  } catch {
    // Not JSON: keep the raw text.
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  return new Agent37ApiError(
    response.status,
    code,
    `Agent37 ${method} ${path} failed (${response.status} ${code}): ${message}`,
    detail,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}
