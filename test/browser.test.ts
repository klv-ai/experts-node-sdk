/**
 * The browser client.
 *
 * Two things carry weight here. First, that an API key cannot get in — the
 * whole reason for a separate entry point. Second, token refresh: a session
 * lasts fifteen minutes and a visitor reading a long answer can outlive one,
 * so without a refresh path the chat simply dies mid-conversation with a 401.
 */

import { describe, expect, it, vi } from "vitest";

import { ExpertsBrowserClient } from "../src/browser-client.js";

const CONV = "11111111-1111-1111-1111-111111111111";

/** A session token shaped like the real one. Never verified client-side. */
function sessionToken(conv = CONV): string {
  const payload = {
    uid: "u",
    user: { uid: "u", role: 1, active: true },
    typ: "session",
    sid: "s_x",
    conv,
    exp_uid: "33333333-3333-3333-3333-333333333333",
    org: "https://customer.example",
  };
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.signature`;
}

function stub(replies: Array<{ status?: number; json?: unknown; ndjson?: string[] }>) {
  let index = 0;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
    if (reply.ndjson) {
      const encoder = new TextEncoder();
      const lines = reply.ndjson;
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
            controller.close();
          },
        }),
        { status: reply.status ?? 200 },
      );
    }
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

describe("refusing an API key", () => {
  it("throws rather than sending one", () => {
    expect(
      () => new ExpertsBrowserClient({ baseUrl: "https://x.example", token: "sk-live" }),
    ).toThrow(/API key, not a session token/);
  });

  it("requires a token at all", () => {
    expect(
      () => new ExpertsBrowserClient({ baseUrl: "https://x.example", token: "" }),
    ).toThrow(/session token is required/);
  });
});

describe("binding", () => {
  it("reads the bound conversation out of the token", () => {
    // So a widget can restore its transcript without being told the uid
    // separately — the token already carries it.
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
    });
    expect(client.conversationUid).toBe(CONV);
  });

  it("tolerates a token it cannot parse", () => {
    // The server is the authority on validity. A client that throws on an
    // unfamiliar token shape breaks on a claim change it did not need to see.
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: "not.a.jwt",
    });
    expect(client.conversationUid).toBe("");
  });

  it("sends messages to the bound conversation", async () => {
    const { impl, calls } = stub([
      { json: { uid: "user-row" } },
      { json: { uid: "stub-row" } },
      { ndjson: [JSON.stringify({ done: true, message: { content: "" } })] },
    ]);
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
    });
    await (await client.send("hello")).text();
    expect(calls).toHaveLength(3);
  });
});

describe("token refresh", () => {
  it("retries once with a fresh token after a 401", async () => {
    const { impl } = stub([
      { status: 401, json: { error: "session_revoked" } },
      { json: { uid: CONV, messages: [] } },
    ]);
    const onExpired = vi.fn(async () => sessionToken());

    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
      onExpired,
    });

    await expect(client.history()).resolves.toMatchObject({ uid: CONV });
    expect(onExpired).toHaveBeenCalledOnce();
  });

  it("surfaces the 401 when there is no refresh handler", async () => {
    const { impl } = stub([{ status: 401, json: { error: "session_revoked" } }]);
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
    });
    await expect(client.history()).rejects.toMatchObject({ status: 401 });
  });

  it("surfaces the 401 when the handler cannot produce a token", async () => {
    const { impl } = stub([{ status: 401, json: {} }]);
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
      onExpired: () => undefined,
    });
    await expect(client.history()).rejects.toMatchObject({ status: 401 });
  });

  it("does not refresh on other errors", async () => {
    // A 403 means the session is confined, not expired. Minting another
    // token would produce exactly the same refusal.
    const { impl } = stub([{ status: 403, json: { error: "session_scope" } }]);
    const onExpired = vi.fn(async () => sessionToken());
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
      onExpired,
    });
    await expect(client.history()).rejects.toMatchObject({ status: 403 });
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("does not loop when the fresh token is also rejected", async () => {
    const { impl, calls } = stub([{ status: 401, json: {} }]);
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
      onExpired: async () => sessionToken(),
    });
    await expect(client.history()).rejects.toMatchObject({ status: 401 });
    // The original plus exactly one retry.
    expect(calls).toHaveLength(2);
  });

  it("uses the new token on subsequent calls", async () => {
    const replacement = sessionToken("22222222-2222-2222-2222-222222222222");
    const { impl, calls } = stub([
      { status: 401, json: {} },
      { json: { uid: CONV, messages: [] } },
    ]);
    const client = new ExpertsBrowserClient({
      baseUrl: "https://x.example",
      token: sessionToken(),
      fetch: impl,
      onExpired: async () => replacement,
    });
    await client.history();
    expect(calls[1]?.headers["authorization"]).toBe(`Bearer ${replacement}`);
  });
});
