/**
 * The transport.
 *
 * Small on purpose — native `fetch`, no dependencies — but three details here
 * are not obvious and each was learned the hard way against the real API.
 *
 * 1. **Never send two credentials.** The gateway checks `Authorization` first
 *    and that branch is terminal: a stale or malformed bearer token 401s and
 *    never falls through to `X-API-Key`. Sending both means the wrong one
 *    silently decides the outcome, so this sends exactly one.
 *
 * 2. **Check `response.ok` before reading the body.** An error body parses as
 *    perfectly valid JSON — and, on the streaming endpoints, as one valid
 *    NDJSON line. A reader that starts consuming before checking the status
 *    reports "the model returned nothing" for what was a 404.
 *
 * 3. **Retry only what is safe to retry.** 429 and 5xx, with backoff that
 *    honours `Retry-After`. Never a 4xx (the request is wrong and will stay
 *    wrong), and never a non-idempotent generation call — retrying a chat
 *    turn bills twice and can produce two answers.
 */

import { errorFromResponse, ExpertsAbortError, ExpertsServerError } from "./errors.js";

export interface Credentials {
  /** Server-side `sk-` key. Never send this from a browser. */
  apiKey?: string;
  /** Browser session token, or any user JWT. */
  token?: string;
}

export interface TransportOptions extends Credentials {
  baseUrl: string;
  /** Per-request timeout in ms. Streaming calls opt out. Default 60_000. */
  timeout?: number;
  /** Attempts for retryable failures, including the first. Default 3. */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * A body to send as-is, for multipart uploads.
   *
   * Passed straight to fetch and NEVER given a content-type by us: fetch has
   * to set `multipart/form-data` itself so it can include the boundary, and
   * setting it by hand produces a request the server cannot parse.
   */
  rawBody?: BodyInit;
  signal?: AbortSignal;
  /** Opt out of the timeout and of retries — for streaming responses. */
  stream?: boolean;
  /** Force-disable retries for a call that must not be repeated. */
  idempotent?: boolean;
  headers?: Record<string, string>;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class Transport {
  readonly baseUrl: string;
  private readonly credentials: Credentials;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: TransportOptions) {
    if (!options.baseUrl) throw new Error("baseUrl is required");
    if (!options.apiKey && !options.token) {
      throw new Error("Provide either an apiKey (server) or a token (browser session)");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.credentials = { apiKey: options.apiKey, token: options.token };
    this.timeout = options.timeout ?? 60_000;
    this.maxRetries = Math.max(1, options.maxRetries ?? 3);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = options.headers ?? {};
  }

  /**
   * Exactly one credential, as a Bearer token.
   *
   * `Authorization: Bearer sk-...` works as of build pack 1.0.49 and is the
   * form every off-the-shelf client uses. `X-API-Key` is the older header and
   * still works, but sending both would let a stale Authorization decide the
   * request, so it is never used alongside one.
   */
  private authHeader(): Record<string, string> {
    const secret = this.credentials.token ?? this.credentials.apiKey;
    return secret ? { authorization: `Bearer ${secret}` } : {};
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Raw response, status already checked. The caller owns the body. */
  async raw(options: RequestOptions): Promise<Response> {
    const attempts = options.stream || options.idempotent === false ? 1 : this.maxRetries;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      // Streaming responses have no meaningful overall deadline — a long
      // answer is not a hung request.
      const timer = options.stream
        ? undefined
        : setTimeout(() => controller.abort(new Error("Request timed out")), this.timeout);

      try {
        const response = await this.fetchImpl(this.url(options.path, options.query), {
          method: options.method ?? "GET",
          headers: {
            accept: "application/json",
            ...(options.body !== undefined && options.rawBody === undefined
              ? { "content-type": "application/json" }
              : {}),
            ...this.authHeader(),
            ...this.extraHeaders,
            ...options.headers,
          },
          body:
            options.rawBody ??
            (options.body !== undefined ? JSON.stringify(options.body) : undefined),
          signal: controller.signal,
        });

        if (response.ok) return response;

        const error = errorFromResponse({
          status: response.status,
          body: await safeBody(response),
          requestId: response.headers.get("x-request-id") ?? undefined,
          retryAfter: numberOrUndefined(response.headers.get("retry-after")),
        });

        if (attempt < attempts && RETRYABLE.has(response.status)) {
          lastError = error;
          await sleep(backoffMs(attempt, response.headers.get("retry-after")));
          continue;
        }
        throw error;
      } catch (cause) {
        if (options.signal?.aborted) {
          throw new ExpertsAbortError("The request was cancelled", { cause });
        }
        // Anything already typed is a decision, not a transport failure.
        if (cause instanceof Error && cause.name.startsWith("Experts")) throw cause;
        if (attempt < attempts) {
          lastError = cause;
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw new ExpertsServerError(
          cause instanceof Error ? cause.message : "Network request failed",
          { cause },
        );
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ExpertsServerError("Request failed after retries");
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const response = await this.raw(options);
    if (response.status === 204) return undefined as T;
    return (await safeBody(response)) as T;
  }
}

async function safeBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function numberOrUndefined(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const server = numberOrUndefined(retryAfter);
  // The server knows when its window resets; prefer its answer over guessing.
  if (server !== undefined) return Math.min(server * 1000, 60_000);
  const base = Math.min(2 ** (attempt - 1) * 500, 8_000);
  return base + Math.random() * 250; // jitter, so retries do not synchronise
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
