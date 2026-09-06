/**
 * Knowledge.
 *
 * Served by a different service from everything else in the SDK, and it shows:
 * responses are wrapped in `{timestamp, status, message, count, data}`, rows
 * are snake_case, and timestamps are epoch milliseconds rather than ISO
 * strings. A caller should not have to know which service answered, so all
 * three are normalised here — and these tests are what keep that true.
 */

import { describe, expect, it, vi } from "vitest";

import { ExpertsClient } from "../src/client.js";

function client(replies: Array<{ status?: number; json?: unknown }>) {
  let index = 0;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body,
    });
    const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    calls,
    sdk: new ExpertsClient({
      apiKey: "sk-test",
      baseUrl: "https://install.example",
      fetch: impl as unknown as typeof globalThis.fetch,
      maxRetries: 1,
    }),
  };
}

const ENVELOPE = {
  timestamp: 1788678050498,
  status: 200,
  message: "OK",
  count: 1,
};

describe("the envelope", () => {
  it("unwraps {data: [...]}", async () => {
    const { sdk } = client([
      {
        json: {
          ...ENVELOPE,
          data: [{ uid: "c1", name: "Policies", file_count: 12 }],
        },
      },
    ]);
    const collections = await sdk.knowledge.listCollections();
    expect(collections).toEqual([
      expect.objectContaining({ uid: "c1", name: "Policies", fileCount: 12 }),
    ]);
  });

  it("accepts a bare array from an older install", async () => {
    // Not every service on every version wraps. Tolerating both is cheaper
    // than a version check, and the failure otherwise is an empty list rather
    // than an error — which reads as "no documents" and is very confusing.
    const { sdk } = client([{ json: [{ uid: "c1", name: "Bare" }] }]);
    expect((await sdk.knowledge.listCollections())[0]?.uid).toBe("c1");
  });

  it("returns an empty list, not undefined, when data is absent", async () => {
    const { sdk } = client([{ json: { ...ENVELOPE, count: 0 } }]);
    await expect(sdk.knowledge.listCollections()).resolves.toEqual([]);
  });
});

describe("row normalisation", () => {
  it("camelises snake_case fields", async () => {
    const { sdk } = client([
      { json: { ...ENVELOPE, data: [{ uid: "d1", name: "x", collection_uid: "c1" }] } },
    ]);
    expect((await sdk.knowledge.listDocuments())[0]).toMatchObject({
      uid: "d1",
      collectionUid: "c1",
    });
  });

  it("converts epoch millis to ISO", async () => {
    // This service answers in epoch milliseconds while the conversations
    // service answers in ISO strings. A caller doing `new Date(createdAt)` on
    // both gets one right and one in 1970.
    const { sdk } = client([
      { json: { ...ENVELOPE, data: [{ uid: "d1", created_at: 1788678050498 }] } },
    ]);
    const doc = (await sdk.knowledge.listDocuments())[0];
    expect(doc?.createdAt).toBe(new Date(1788678050498).toISOString());
  });

  it("passes an ISO string through unchanged", async () => {
    const iso = "2026-09-06T07:00:14.543124Z";
    const { sdk } = client([
      { json: { ...ENVELOPE, data: [{ uid: "d1", created_at: iso }] } },
    ]);
    expect((await sdk.knowledge.listDocuments())[0]?.createdAt).toBe(iso);
  });

  it("keeps a missing timestamp null rather than inventing an epoch", async () => {
    const { sdk } = client([{ json: { ...ENVELOPE, data: [{ uid: "d1" }] } }]);
    expect((await sdk.knowledge.listDocuments())[0]?.createdAt).toBeNull();
  });
});

describe("processing", () => {
  it("reports ready once the worker has embedded the document", async () => {
    const { sdk } = client([
      { json: { ...ENVELOPE, data: { uid: "d1", processed: false } } },
      { json: { ...ENVELOPE, data: { uid: "d1", processed: true } } },
    ]);
    await expect(
      sdk.knowledge.waitForProcessing("d1", { timeoutMs: 5_000, intervalMs: 1 }),
    ).resolves.toBe(true);
  });

  it("gives up rather than hanging forever", async () => {
    // Uploading is asynchronous and a stuck worker is a real state. A caller
    // needs to be told, not left waiting.
    const { sdk } = client([{ json: { ...ENVELOPE, data: { uid: "d1", processed: false } } }]);
    await expect(
      sdk.knowledge.waitForProcessing("d1", { timeoutMs: 30, intervalMs: 5 }),
    ).resolves.toBe(false);
  });
});

describe("upload", () => {
  it("sends multipart and is never retried", async () => {
    // A retried upload ingests the file twice, which then shows up as
    // duplicate retrieval hits.
    const { sdk, calls } = client([{ json: { ...ENVELOPE, data: { uid: "d1", name: "x" } } }]);
    await sdk.knowledge.upload(new Blob(["hello"]), { collection: "c1", name: "x.txt" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });

  it("carries the collection so the file lands somewhere", async () => {
    const { sdk, calls } = client([{ json: { ...ENVELOPE, data: { uid: "d1" } } }]);
    await sdk.knowledge.upload(new Blob(["hello"]), { collection: "c1" });
    expect((calls[0]?.body as FormData).get("collection_uid")).toBe("c1");
  });
});
