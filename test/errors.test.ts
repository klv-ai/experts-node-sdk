/**
 * Turning a failed response into something a caller can act on.
 *
 * The API speaks three different error envelopes depending on which service
 * answered, and the difference between them is not cosmetic: getting it wrong
 * produces "Request failed with status 403" where the real message said the
 * installation's licence had expired.
 */

import { describe, expect, it } from "vitest";

import {
  errorFromResponse,
  ExpertsAuthError,
  ExpertsBadRequestError,
  ExpertsLicenseError,
  ExpertsNotFoundError,
  ExpertsPermissionError,
  ExpertsRateLimitError,
  ExpertsServerError,
} from "../src/errors.js";

describe("status mapping", () => {
  it.each([
    [400, ExpertsBadRequestError],
    [401, ExpertsAuthError],
    [403, ExpertsPermissionError],
    [404, ExpertsNotFoundError],
    [422, ExpertsBadRequestError],
    [429, ExpertsRateLimitError],
    [500, ExpertsServerError],
    [502, ExpertsServerError],
  ])("%i", (status, type) => {
    expect(errorFromResponse({ status, body: {} })).toBeInstanceOf(type);
  });
});

describe("envelope shapes", () => {
  it("reads FastAPI's {detail}", () => {
    expect(errorFromResponse({ status: 404, body: { detail: "Conversation not found" } })
      .message).toBe("Conversation not found");
  });

  it("reads OpenAI's {error: {message, type}}", () => {
    const error = errorFromResponse({
      status: 400,
      body: { error: { message: "`n` > 1 is not supported", type: "invalid_request_error" } },
    });
    expect(error.message).toBe("`n` > 1 is not supported");
    expect(error.code).toBe("invalid_request_error");
  });

  it("reads keyguard's {error: '...', detail: '...'}", () => {
    const error = errorFromResponse({
      status: 403,
      body: { error: "license_expired", detail: "Please contact your administrator." },
    });
    expect(error.code).toBe("license_expired");
  });

  it("reads the session middleware's {error, detail}", () => {
    const error = errorFromResponse({
      status: 403,
      body: { error: "session_scope", detail: "A browser session cannot reach this." },
    });
    expect(error).toBeInstanceOf(ExpertsPermissionError);
    expect(error.code).toBe("session_scope");
    expect(error.message).toBe("A browser session cannot reach this.");
  });

  it("handles a plain-text body", () => {
    expect(errorFromResponse({ status: 502, body: "Bad Gateway" }).message)
      .toBe("Bad Gateway");
  });

  it("handles a validation error array without dumping an object", () => {
    const error = errorFromResponse({
      status: 422,
      body: { detail: [{ loc: ["body", "model"], msg: "field required" }] },
    });
    expect(error.message).toContain("field required");
  });

  it("falls back to something meaningful on an empty body", () => {
    expect(errorFromResponse({ status: 500, body: null }).message)
      .toBe("Request failed with status 500");
  });

  it("truncates an enormous body rather than putting it all in a message", () => {
    const error = errorFromResponse({ status: 500, body: "x".repeat(5000) });
    expect(error.message.length).toBeLessThanOrEqual(500);
  });
});

describe("an expired licence is its own thing", () => {
  const body = { error: "license_expired", message: "Your license has expired." };

  it("is not merely a permission error", () => {
    // Nothing about the request is wrong and no retry helps. Reporting
    // "forbidden" sends a developer to debug their own code for an hour.
    const error = errorFromResponse({ status: 403, body });
    expect(error).toBeInstanceOf(ExpertsLicenseError);
    expect(error).not.toBeInstanceOf(ExpertsPermissionError);
  });

  it("says who can actually fix it", () => {
    expect(errorFromResponse({ status: 403, body }).message)
      .toMatch(/installation's licence|administrator/i);
  });

  it("leaves an ordinary 403 alone", () => {
    const error = errorFromResponse({ status: 403, body: { detail: "Not yours" } });
    expect(error).toBeInstanceOf(ExpertsPermissionError);
    expect(error).not.toBeInstanceOf(ExpertsLicenseError);
  });
});

describe("carried context", () => {
  it("keeps the status, body and request id", () => {
    const body = { detail: "nope" };
    const error = errorFromResponse({ status: 404, body, requestId: "req-123" });
    expect(error.status).toBe(404);
    expect(error.body).toBe(body);
    expect(error.requestId).toBe("req-123");
  });

  it("exposes retry-after on a 429", () => {
    const error = errorFromResponse({ status: 429, body: {}, retryAfter: 30 });
    expect((error as ExpertsRateLimitError).retryAfter).toBe(30);
  });

  it("names itself usefully in a stack trace", () => {
    expect(errorFromResponse({ status: 401, body: {} }).name).toBe("ExpertsAuthError");
  });

  it("is catchable as a plain Error", () => {
    expect(errorFromResponse({ status: 500, body: {} })).toBeInstanceOf(Error);
  });
});
