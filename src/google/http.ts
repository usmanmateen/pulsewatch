/**
 * Transport-level helpers shared by the OAuth and Health API clients.
 */

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GoogleErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'invalid_response';

/** Error carrying only non-sensitive metadata (kind, HTTP status, Google status code). */
export class GoogleApiError extends Error {
  override readonly name = 'GoogleApiError';
  readonly code: string;

  constructor(
    readonly kind: GoogleErrorKind,
    readonly status?: number,
    /** Google's canonical status, e.g. PERMISSION_DENIED. Never user data. */
    readonly googleStatus?: string,
    /**
     * Google's validation message, kept only for 4xx client errors: it
     * describes the request PulseWatch sent (a field or value it rejected),
     * which is what makes a contract mismatch diagnosable.
     */
    readonly detail?: string,
  ) {
    super(`google_${kind}${status ? `_${status}` : ''}`);
    this.code = `google_${kind}`;
  }

  get retryable(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'server' ||
      this.kind === 'timeout' ||
      this.kind === 'network'
    );
  }
}

export function kindForStatus(status: number): GoogleErrorKind {
  // Requests use redirect: 'manual' (Workers does not support 'error');
  // Google APIs never redirect, so a 3xx is an unexpected response.
  if (status >= 300 && status < 400) return 'invalid_response';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Maps a thrown fetch error (abort/timeout vs network) to a kind. */
export function kindForThrown(error: unknown): GoogleErrorKind {
  if (error instanceof GoogleApiError) return error.kind;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  return 'network';
}

/**
 * Reads a JSON body without trusting its size. Health API pages are small
 * once field masks apply; anything huge is treated as a malformed response
 * rather than risking the Worker's memory and CPU budget.
 */
export async function readJsonBounded(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  if (!response.body) throw new GoogleApiError('invalid_response', response.status);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new GoogleApiError('invalid_response', response.status);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new GoogleApiError('invalid_response', response.status);
  }
}

/** Google's error message for a client error, trimmed to printable, bounded text. */
export function googleErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = body.error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = error.message;
      if (typeof message === 'string') return message.replace(/[^ -~]/g, ' ').slice(0, 240);
    }
  }
  return undefined;
}

/** Extracts Google's canonical error status (e.g. PERMISSION_DENIED) if present. */
export function googleErrorStatus(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = body.error;
    if (error && typeof error === 'object' && 'status' in error) {
      const status = error.status;
      if (typeof status === 'string' && /^[A-Z_]{1,64}$/.test(status)) return status;
    }
  }
  return undefined;
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful to do; the body is being discarded anyway.
  }
}
