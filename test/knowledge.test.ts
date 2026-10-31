/**
 * Knowledge.
 *
 * Served by a different service from everything else in the SDK, and it shows:
 * responses are wrapped in `{timestamp, status, message, count, data}`, rows
 * are snake_case, and timestamps are epoch milliseconds rather than ISO
 * strings. A caller should not have to know which service answered, so all
 * three are normalised here — and these tests are what keep that true.
 *
 * The payloads are copied from a 1.1 install (build pack 1.1.0-rc.127). The
 * 0.1 release mocked the shapes it expected instead, which is how its upload,
 * search and processing wait shipped without ever having worked.
 */

import { describe, expect, it, vi } from "vitest";

import { ExpertsClient } from "../src/client.js";

function client(replies: Array<{ status?: number; json?: unknown }>) {
  let index = 0;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const body = (i: number) => JSON.parse(String(calls[i]?.body)) as Record<string, unknown>;
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
    body,
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

const COLLECTION = "d0f5ac46-0000-4000-8000-000000000001";
const DOC = "54137bfb-f499-4502-81d3-8bf1ab0970a6";

function jobStatus(queue: Array<Record<string, unknown>>, total = 1) {
  // Not enveloped, unlike the rest of the knowledge service.
  return {
    id: 24,
    kind: 0,
    total_files: total,
    error_count: 0,
    queue,
    queue_total: queue.length,
    has_more: false,
  };
}

function entry(statusId: number, extra: Record<string, unknown> = {}) {
  return { status_id: statusId, object_uid: DOC, object_name: "policy.txt", extra: null, ...extra };
}

describe("documents", () => {
  it("maps rows from their wire names", async () => {
    const { sdk } = client([
      {
        json: {
          ...ENVELOPE,
          data: [
            {
              uid: DOC,
              doc_name: "policy.pdf",
              doc_type: "pdf",
              title: "Refund policy",
              summary: "How refunds work.",
              file_size: 2048,
            },
          ],
        },
      },
    ]);
    expect((await sdk.knowledge.listDocuments({ collection: COLLECTION }))[0]).toMatchObject({
      uid: DOC,
      name: "policy.pdf",
      type: "pdf",
      title: "Refund policy",
      summary: "How refunds work.",
      description: "How refunds work.",
      size: 2048,
      // The row names no collection; the one it was listed from is kept.
      collectionUid: COLLECTION,
    });
  });

  it("filters by the parameter the server reads", async () => {
    const { sdk, calls } = client([{ json: { ...ENVELOPE, data: [] } }]);
    await sdk.knowledge.listDocuments({ collection: COLLECTION, limit: 5, search: "refund" });
    const url = new URL(calls[0]?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      collection: COLLECTION,
      limit: "5",
      searchTerm: "refund",
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

  it("deletes", async () => {
    const { sdk, calls } = client([{ json: { status: 204, message: "Deleted" } }]);
    await sdk.knowledge.deleteDocument(DOC);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `DELETE /api/v1/documents/${DOC}`,
    ]);
  });
});

describe("upload", () => {
  it("sends multipart and is never retried", async () => {
    // A retried upload ingests the file twice, which then shows up as
    // duplicate retrieval hits.
    const { sdk, calls } = client([{ status: 503, json: { detail: "busy" } }]);
    await expect(
      sdk.knowledge.upload(new Blob(["hello"]), { collection: COLLECTION, name: "x.txt" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });

  it("uses the form fields the server reads, and answers with the job", async () => {
    // `files`, plural, and `collection` — anything else is a 422, or a file
    // that lands in no collection.
    const { sdk, calls } = client([
      {
        json: {
          timestamp: 1,
          status: 200,
          message: "Processing 1 files on the embedding queue",
          job_queue_run_id: 24,
        },
      },
    ]);
    const job = await sdk.knowledge.upload(new Blob(["hello"]), {
      collection: COLLECTION,
      name: "policy.txt",
    });
    expect(job).toEqual({ jobId: 24, message: "Processing 1 files on the embedding queue" });
    const form = calls[0]?.body as FormData;
    expect(form.get("collection")).toBe(COLLECTION);
    expect((form.get("files") as File).name).toBe("policy.txt");
  });
});

describe("processing", () => {
  it("polls the job until the file is searchable", async () => {
    const { sdk, calls } = client([
      { json: jobStatus([]) }, // accepted, not yet queued
      { json: jobStatus([entry(1)]) }, // working
      { json: jobStatus([entry(2)]) }, // searchable, summary pending
    ]);
    const status = await sdk.knowledge.waitForProcessing(24, { intervalMs: 1 });
    expect(status).toMatchObject({ jobId: 24, done: true, ready: true, documentUids: [DOC] });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(
      Array(3).fill("/api/v1/documents/job-queue-status/24"),
    );
  });

  it("says why a file failed", async () => {
    const { sdk } = client([
      { json: jobStatus([entry(-1, { object_uid: null, extra: "This PDF is password-protected." })]) },
    ]);
    const status = await sdk.knowledge.waitForProcessing({ jobId: 24, message: "" });
    expect(status.done).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.failed[0]?.error).toBe("This PDF is password-protected.");
  });

  it("gives up rather than hanging forever", async () => {
    // Uploading is asynchronous and a stuck worker is a real state. A caller
    // needs to be told, not left waiting.
    const { sdk } = client([{ json: jobStatus([entry(1)]) }]);
    const status = await sdk.knowledge.waitForProcessing(24, { timeoutMs: 30, intervalMs: 5 });
    expect(status.done).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.files[0]?.status).toBe("working");
  });
});

describe("search", () => {
  const HIT = {
    cosine_dist: 0.25,
    split_text: "Refunds are issued within 14 days.",
    split_order: 0,
    text_split_uid: "split-1",
    source_doc_uid: DOC,
    doc_name: "policy.txt",
    title: null,
    summary: null,
    doc_uri: "",
    page_number: 3,
    source_location: null,
    start_ms: null,
    end_ms: null,
    match_source: "both",
    rrf_score: null,
    rerank_score: 0.9,
  };

  it("is the RAG search, with the body it takes", async () => {
    const { sdk, calls, body } = client([{ json: { ...ENVELOPE, data: [] } }]);
    await sdk.knowledge.search("refunds", { collections: [COLLECTION], limit: 3 });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/similarity_search/");
    expect(body(0)).toEqual({ prompt: "refunds", top_k: 3, collections: [COLLECTION] });
  });

  it("leaves collections out when there are none", async () => {
    // An empty list is not "everything" to the service: it builds a query
    // that fails with a 500.
    const { sdk, body } = client([{ json: { ...ENVELOPE, data: [] } }]);
    await sdk.knowledge.search("refunds");
    expect(body(0)).not.toHaveProperty("collections");
  });

  it("answers with passages and their documents", async () => {
    const { sdk } = client([{ json: { ...ENVELOPE, data: [HIT] } }]);
    const [hit] = await sdk.knowledge.search("refunds");
    expect(hit).toMatchObject({
      text: "Refunds are issued within 14 days.",
      documentUid: DOC,
      documentName: "policy.txt",
      pageNumber: 3,
      rerankScore: 0.9,
      splitUid: "split-1",
    });
    expect(hit?.similarity).toBeCloseTo(0.75);
  });
});
