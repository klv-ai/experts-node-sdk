/**
 * The transport.
 *
 * Retry policy is the substance here, and it is a correctness question rather
 * than a tuning one: retrying a chat turn bills the customer twice and can
 * produce two different answers, while retrying a 4xx just makes a wrong
 * request three times.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Transport } from "../src/http.js";
import {
  ExpertsAbortError,
  ExpertsBadRequestError,
  ExpertsRateLimitError,
  ExpertsServerError,
} from "../src/errors.js";

interface Reply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  throw?: Error;
}

function stub(replies: Reply[]) {
  let index = 0;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
    if (reply.throw) throw reply.throw;
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

function transport(replies: Reply[], options: Record<string, unknown> = {}) {
  const { impl, calls } = stub(replies);
  return {
    calls,
    t: new Transport({
      baseUrl: "https://install.example",
      apiKey: "sk-test",
      fetch: impl,
      ...options,
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("construction", () => {
  it("requires a credential", () => {
    expect(() => new Transport({ baseUrl: "https://x.example" })).toThrow(
      /apiKey .* or a token/,
    );
  });

  it("requires a base url", () => {
    expect(() => new Transport({ baseUrl: "", apiKey: "sk-x" })).toThrow(/baseUrl/);
  });

  it("tolerates a trailing slash on the base url", async () => {
    const { impl, calls } = stub([{ json: {} }]);
    const t = new Transport({
      baseUrl: "https://install.example/",
      apiKey: "sk-x",
      fetch: impl,
    });
    await t.request({ path: "/api/v1/thing" });
    expect(calls[0]?.url).toBe("https://install.example/api/v1/thing");
  });
});

describe("query strings", () => {
  it("appends parameters", async () => {
    const { t, calls } = transport([{ json: {} }]);
    await t.request({ path: "/x", query: { limit: 10, active: true } });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("active")).toBe("true");
  });

  it("omits undefined parameters rather than sending 'undefined'", async () => {
    const { t, calls } = transport([{ json: {} }]);
    await t.request({ path: "/x", query: { limit: undefined } });
    expect(new URL(calls[0]!.url).searchParams.has("limit")).toBe(false);
  });
});

describe("retries", () => {
  it("retries a 503 and succeeds", async () => {
    const { t, calls } = transport([{ status: 503 }, { json: { ok: true } }]);
    await expect(t.request({ path: "/x" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    const { t, calls } = transport([{ status: 500 }], { maxRetries: 3 });
    await expect(t.request({ path: "/x" })).rejects.toBeInstanceOf(ExpertsServerError);
    expect(calls).toHaveLength(3);
  });

  it("never retries a 4xx", async () => {
    // The request is wrong and will stay wrong; repeating it just triples the
    // latency before the caller sees the real problem.
    const { t, calls } = transport([{ status: 400, json: { detail: "bad" } }]);
    await expect(t.request({ path: "/x" })).rejects.toBeInstanceOf(ExpertsBadRequestError);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429", async () => {
    const { t, calls } = transport([{ status: 429 }, { json: { ok: true } }]);
    await t.request({ path: "/x" });
    expect(calls).toHaveLength(2);
  });

  it("retries a network failure", async () => {
    const { t, calls } = transport([
      { throw: new TypeError("fetch failed") },
      { json: { ok: true } },
    ]);
    await t.request({ path: "/x" });
    expect(calls).toHaveLength(2);
  });

  it("never retries a call marked non-idempotent", async () => {
    // What protects a chat turn: a retry bills twice and can produce two
    // different answers.
    const { t, calls } = transport([{ status: 503 }], { maxRetries: 3 });
    await expect(t.request({ path: "/x", idempotent: false })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("never retries a stream", async () => {
    const { t, calls } = transport([{ status: 503 }], { maxRetries: 3 });
    await expect(t.raw({ path: "/x", stream: true })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("surfaces the last error, not a generic one", async () => {
    const { t } = transport([{ status: 429, json: { detail: "too fast" } }], {
      maxRetries: 2,
    });
    const error = (await t.request({ path: "/x" }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(ExpertsRateLimitError);
    expect(error.message).toBe("too fast");
  });
});

describe("timeouts and cancellation", () => {
  it("gives up on a request that never answers", async () => {
    const impl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    ) as unknown as typeof globalThis.fetch;

    const t = new Transport({
      baseUrl: "https://install.example",
      apiKey: "sk-x",
      fetch: impl,
      timeout: 50,
      maxRetries: 1,
    });

    const promise = t.request({ path: "/x" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(((await promise) as Error).message).toMatch(/timed out/i);
  });

  it("does not time out a stream", async () => {
    // A long answer is not a hung request; a deadline here would truncate
    // exactly the responses worth waiting for.
    let signal: AbortSignal | undefined;
    const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const t = new Transport({
      baseUrl: "https://install.example",
      apiKey: "sk-x",
      fetch: impl,
      timeout: 10,
    });
    await t.raw({ path: "/x", stream: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(signal?.aborted).toBe(false);
  });

  it("reports a caller abort as an abort, not a server failure", async () => {
    const controller = new AbortController();
    const impl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof globalThis.fetch;

    const t = new Transport({
      baseUrl: "https://install.example",
      apiKey: "sk-x",
      fetch: impl,
      maxRetries: 1,
    });

    const promise = t
      .request({ path: "/x", signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();
    expect(await promise).toBeInstanceOf(ExpertsAbortError);
  });
});

describe("bodies", () => {
  it("sends JSON with a content-type", async () => {
    const { t, calls } = transport([{ json: {} }]);
    await t.request({ method: "POST", path: "/x", body: { a: 1 } });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]!.init!.body).toBe('{"a":1}');
  });

  it("leaves a multipart body's content-type to fetch", async () => {
    // fetch has to set multipart/form-data itself so it can include the
    // boundary. Setting it by hand produces a request the server cannot parse.
    const { t, calls } = transport([{ json: {} }]);
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.txt");
    await t.raw({ method: "POST", path: "/upload", rawBody: form });

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(calls[0]!.init!.body).toBe(form);
  });

  it("returns undefined for a 204", async () => {
    const impl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as
      typeof globalThis.fetch;
    const t = new Transport({ baseUrl: "https://x.example", apiKey: "sk-x", fetch: impl });
    await expect(t.request({ path: "/x" })).resolves.toBeUndefined();
  });

  it("returns a non-JSON body as text rather than throwing", async () => {
    const impl = vi.fn(
      async () => new Response("plain text", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const t = new Transport({ baseUrl: "https://x.example", apiKey: "sk-x", fetch: impl });
    await expect(t.request({ path: "/x" })).resolves.toBe("plain text");
  });
});

describe("credentials", () => {
  it("prefers a session token over an api key when both are given", async () => {
    const { impl, calls } = stub([{ json: {} }]);
    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "sk-key",
      token: "jwt-token",
      fetch: impl,
    });
    await t.request({ path: "/x" });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer jwt-token");
  });

  it("sends extra headers", async () => {
    const { impl, calls } = stub([{ json: {} }]);
    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "sk-x",
      fetch: impl,
      headers: { "x-trace": "abc" },
    });
    await t.request({ path: "/x" });
    expect((calls[0]!.init!.headers as Record<string, string>)["x-trace"]).toBe("abc");
  });
});
