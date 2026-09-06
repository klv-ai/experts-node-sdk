/**
 * The client, against a stubbed transport.
 *
 * The three-call send sequence is the centrepiece: on the raw API a chat turn
 * is three requests in a specific order, and skipping the first two fails
 * SILENTLY — the model answers, the stream looks fine, and nothing persists.
 * These assert the calls actually happen and in the right order.
 */

import { describe, expect, it, vi } from "vitest";

import { ExpertsClient } from "../src/client.js";
import { ExpertsBrowserClient } from "../src/browser-client.js";
import {
  ExpertsAuthError,
  ExpertsLicenseError,
  ExpertsNotFoundError,
  ExpertsPermissionError,
  ExpertsRateLimitError,
} from "../src/errors.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub that records calls and replies from a queue. */
function stubFetch(replies: Array<{ status?: number; json?: unknown; ndjson?: string[]; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let index = 0;

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });

    const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
    const status = reply.status ?? 200;

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
        { status, headers: { "content-type": "application/x-ndjson" } },
      );
    }
    return new Response(JSON.stringify(reply.json ?? {}), {
      status,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  });

  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

function client(replies: Parameters<typeof stubFetch>[0]) {
  const { impl, calls } = stubFetch(replies);
  return {
    calls,
    sdk: new ExpertsClient({
      apiKey: "sk-test",
      baseUrl: "https://install.example",
      fetch: impl,
      maxRetries: 1,
    }),
  };
}

describe("credentials", () => {
  it("sends the key as a Bearer token", async () => {
    const { sdk, calls } = client([{ json: [] }]);
    await sdk.experts.list();
    expect(calls[0]?.headers["authorization"]).toBe("Bearer sk-test");
  });

  it("never sends two credentials at once", async () => {
    // The gateway checks Authorization first and that branch is terminal: a
    // stale bearer token 401s and never falls through to X-API-Key. Sending
    // both lets the wrong one silently decide the request.
    const { sdk, calls } = client([{ json: [] }]);
    await sdk.experts.list();
    expect(calls[0]?.headers).not.toHaveProperty("x-api-key");
  });

  it("refuses to construct in a browser", () => {
    // Bearer support makes putting the key in front-end code a one-line
    // change, so this has to fail loudly at construction.
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    try {
      expect(
        () => new ExpertsClient({ apiKey: "sk-test", baseUrl: "https://x.example" }),
      ).toThrow(/must not run in a browser/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses an API key handed to the browser client", () => {
    expect(
      () => new ExpertsBrowserClient({ baseUrl: "https://x.example", token: "sk-oops" }),
    ).toThrow(/API key, not a session token/);
  });
});

describe("sending a message", () => {
  const sendReplies = [
    { json: { uid: "user-row" } }, // 1. the user's turn
    { json: { uid: "stub-row" } }, // 2. the assistant placeholder
    {
      ndjson: [
        JSON.stringify({ type: "stream", message: { content: "4" }, done: false }),
        JSON.stringify({
          type: "stream",
          message: { content: "" },
          done: true,
          done_reason: "stop",
          eval_count: 1,
          response: "stub-row",
        }),
      ],
    },
  ];

  it("makes all three calls, in order", async () => {
    const { sdk, calls } = client(sendReplies);
    await (await sdk.conversations.send("conv-1", "What is 2+2?")).text();

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/v1/responses/",
      "POST /api/v1/responses/",
      "POST /api/v1/conversations/chat",
    ]);
  });

  it("posts the user turn as settled and the assistant row as pending", async () => {
    const { sdk, calls } = client(sendReplies);
    await (await sdk.conversations.send("conv-1", "What is 2+2?")).text();

    expect(calls[0]?.body).toMatchObject({ agent: false, done: true, text: "What is 2+2?" });
    expect(calls[1]?.body).toMatchObject({ agent: true, done: false, text: "" });
  });

  it("passes the placeholder uid to /chat", async () => {
    // Without it the model still answers and the stream looks fine, but
    // nothing is persisted and every event carries an empty `response`.
    const { sdk, calls } = client(sendReplies);
    await (await sdk.conversations.send("conv-1", "hi")).text();
    expect(calls[2]?.body).toMatchObject({ response: "stub-row" });
  });

  it("aggregates the answer", async () => {
    const { sdk } = client(sendReplies);
    expect(await (await sdk.conversations.send("conv-1", "hi")).text()).toBe("4");
  });

  it("exposes typed events", async () => {
    const { sdk } = client(sendReplies);
    const stream = await sdk.conversations.send("conv-1", "hi");
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types).toEqual(["token", "done"]);
  });

  it("refuses to be consumed twice", async () => {
    const { sdk } = client(sendReplies);
    const stream = await sdk.conversations.send("conv-1", "hi");
    await stream.text();
    await expect(async () => {
      for await (const _ of stream) void _;
    }).rejects.toThrow(/already been consumed/);
  });
});

describe("cancelling", () => {
  it("calls the cancel endpoint rather than just dropping the stream", async () => {
    // Generation is DETACHED server-side: walking away stops the relay, not
    // the model. It keeps generating, keeps billing, and still persists.
    const { sdk, calls } = client([
      { json: { uid: "user-row" } },
      { json: { uid: "stub-row" } },
      { ndjson: [JSON.stringify({ type: "stream", message: { content: "x" }, done: false })] },
      { json: { cancelled: true } },
    ]);
    const stream = await sdk.conversations.send("conv-1", "hi");
    await stream.cancel();

    expect(new URL(calls[3]!.url).pathname).toBe("/api/v1/conversations/chat/stub-row/cancel");
  });
});

describe("errors", () => {
  it.each([
    [401, {}, ExpertsAuthError],
    [403, { detail: "nope" }, ExpertsPermissionError],
    [404, { detail: "gone" }, ExpertsNotFoundError],
    [429, { detail: "slow" }, ExpertsRateLimitError],
  ])("maps %i to the right type", async (status, json, type) => {
    const { sdk } = client([{ status, json }]);
    await expect(sdk.experts.list()).rejects.toBeInstanceOf(type);
  });

  it("distinguishes an expired licence from a permission problem", async () => {
    // Nothing about the request is wrong and no retry will help — the
    // install's administrator has to renew. Reporting "forbidden" sends a
    // developer to debug their own code for an hour.
    const { sdk } = client([
      { status: 403, json: { error: "license_expired", message: "Your license has expired." } },
    ]);
    const error = await sdk.experts.list().catch((e) => e);
    expect(error).toBeInstanceOf(ExpertsLicenseError);
    expect(error.message).toMatch(/installation's licence/);
  });

  it("reads retry-after off a 429", async () => {
    const { sdk } = client([
      { status: 429, json: { detail: "slow" }, headers: { "retry-after": "42" } },
    ]);
    const error = await sdk.experts.list().catch((e) => e);
    expect(error.retryAfter).toBe(42);
  });

  it("does not report a 404 body as an empty answer", async () => {
    // A 404 body is valid JSON, and on a streaming endpoint it is one valid
    // NDJSON line. Reading before checking the status turns "conversation not
    // found" into "the model returned nothing".
    const { sdk } = client([{ status: 404, json: { detail: "Conversation not found" } }]);
    const error = await sdk.conversations.get("missing").catch((e) => e);
    expect(error).toBeInstanceOf(ExpertsNotFoundError);
    expect(error.message).toBe("Conversation not found");
  });
});

describe("normalisation", () => {
  it("camelises snake_case expert rows", async () => {
    const { sdk } = client([
      {
        json: [
          {
            uid: "e1",
            name: "Support",
            model_file: "You are helpful.",
            min_role_id: 1,
            output_language: "English (US)",
            private: false,
          },
        ],
      },
    ]);
    expect(await sdk.experts.list()).toEqual([
      expect.objectContaining({
        uid: "e1",
        instructions: "You are helpful.",
        minRoleId: 1,
        outputLanguage: "English (US)",
      }),
    ]);
  });

  it("filters experts a browser session could actually use", async () => {
    // A session token is a guest. An expert above that floor resolves to
    // nothing server-side and the chat silently answers on the site default
    // model with no persona.
    const { sdk } = client([
      {
        json: [
          { uid: "guest-ok", name: "A", min_role_id: 1, private: false },
          { uid: "too-high", name: "B", min_role_id: 2, private: false },
          { uid: "is-private", name: "C", min_role_id: 1, private: true },
        ],
      },
    ]);
    expect((await sdk.experts.listGuestVisible()).map((e) => e.uid)).toEqual(["guest-ok"]);
  });
});
