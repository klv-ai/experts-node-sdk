/**
 * Typed errors.
 *
 * The distinctions here are the ones a caller has to act on differently, not
 * a taxonomy for its own sake. In particular `ExpertsLicenseError` is not a
 * variety of "forbidden": it says the *installation's* licence has lapsed, so
 * no amount of fixing the request will help and the person who can fix it is
 * the install's administrator, not the developer reading the stack trace.
 */

/** Base for everything this SDK throws. */
export class ExpertsError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** The parsed response body, when there was one. */
  readonly body: unknown;
  /** Server request id, if the install returned one. Quote it in a bug report. */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      body?: unknown;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
    this.requestId = options.requestId;
  }
}

/** 401 — the credential is missing, malformed, expired or revoked. */
export class ExpertsAuthError extends ExpertsError {}

/** 403 — authenticated, but not allowed to do this. */
export class ExpertsPermissionError extends ExpertsError {}

/**
 * 403 with `{"error": "license_expired"}` — the INSTALL's licence has lapsed.
 *
 * Separate from ExpertsPermissionError on purpose. Nothing about the request
 * is wrong and no retry or credential change will help; the install's
 * administrator has to renew. Telling a developer "forbidden" here sends them
 * to debug their own code for an hour.
 */
export class ExpertsLicenseError extends ExpertsError {}

/**
 * 404 — or a resource this credential may not see.
 *
 * The API answers "not found" rather than "forbidden" for a conversation the
 * caller has no access to, deliberately: a uid probe must not reveal whether
 * something exists. So this can mean either, and the SDK does not guess.
 */
export class ExpertsNotFoundError extends ExpertsError {}

/** 429 — slow down. `retryAfter` is in seconds when the server said. */
export class ExpertsRateLimitError extends ExpertsError {
  readonly retryAfter: number | undefined;

  constructor(message: string, options: ConstructorParameters<typeof ExpertsError>[1] & {
    retryAfter?: number;
  } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** 5xx, or a transport failure. Retried automatically before it surfaces. */
export class ExpertsServerError extends ExpertsError {}

/** 4xx that is none of the above — a malformed request. */
export class ExpertsBadRequestError extends ExpertsError {}

/**
 * The stream ended without a terminal event.
 *
 * Usually a dropped connection. Note that on this platform generation is
 * DETACHED from the HTTP request: the answer very likely completed on the
 * server and was persisted, so re-reading the conversation is the right
 * recovery, not resending the question.
 */
export class ExpertsStreamError extends ExpertsError {}

/** The caller aborted, via `stream.cancel()` or an AbortSignal. */
export class ExpertsAbortError extends ExpertsError {}

interface ErrorShape {
  status: number;
  body: unknown;
  requestId?: string;
  retryAfter?: number;
}

function messageFrom(body: unknown, status: number): { message: string; code?: string } {
  if (typeof body === "string" && body.trim()) {
    return { message: body.trim().slice(0, 500) };
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;

    // The OpenAI-compatible surface: {"error": {"message", "type", "code"}}
    const error = record["error"];
    if (error && typeof error === "object") {
      const e = error as Record<string, unknown>;
      return {
        message: String(e["message"] ?? "Request failed"),
        code: typeof e["type"] === "string" ? e["type"] : undefined,
      };
    }
    // Keyguard: {"error": "license_expired", "message": ..., "detail": ...}
    if (typeof error === "string") {
      const detail = record["message"] ?? record["detail"];
      return { message: String(detail ?? error), code: error };
    }
    // FastAPI's default: {"detail": ...}
    const detail = record["detail"];
    if (typeof detail === "string") return { message: detail };
    if (Array.isArray(detail)) return { message: JSON.stringify(detail).slice(0, 500) };
  }
  return { message: `Request failed with status ${status}` };
}

/** Build the right error subclass from a failed response. */
export function errorFromResponse({ status, body, requestId, retryAfter }: ErrorShape): ExpertsError {
  const { message, code } = messageFrom(body, status);
  const options = { status, code, body, requestId };

  if (status === 401) return new ExpertsAuthError(message, options);
  if (status === 403) {
    // An install-level failure wearing a request-level status code.
    if (code === "license_expired") {
      return new ExpertsLicenseError(
        `${message} (the installation's licence has expired — this is not something ` +
          `your request or credentials can fix)`,
        options,
      );
    }
    return new ExpertsPermissionError(message, options);
  }
  if (status === 404) return new ExpertsNotFoundError(message, options);
  if (status === 429) return new ExpertsRateLimitError(message, { ...options, retryAfter });
  if (status >= 500) return new ExpertsServerError(message, options);
  return new ExpertsBadRequestError(message, options);
}
