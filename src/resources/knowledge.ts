/**
 * Knowledge — the corpus experts retrieve from.
 *
 * Served by the embedding module rather than the conversations service, which
 * shows in the wire format: every response is wrapped in
 * `{timestamp, status, message, count, data}` and the rows inside are
 * snake_case. Unwrapped here so callers see the same shape as everywhere else.
 *
 * Uploading is asynchronous. A document is accepted, then split, embedded and
 * indexed by a worker — so a file that has just uploaded is NOT yet
 * retrievable. `waitForProcessing()` is the honest way to sequence an ingest.
 */

import type { Transport } from "../http.js";
import type { Collection, KnowledgeDocument, UUID } from "../types.js";

interface Envelope<T> {
  timestamp?: number;
  status?: number;
  message?: string;
  count?: number;
  data?: T;
}

interface RawCollection {
  uid: string;
  name?: string;
  description?: string | null;
  file_count?: number;
  created_at?: number | string | null;
  updated_at?: number | string | null;
}

interface RawDocument {
  uid: string;
  name?: string;
  type?: string | null;
  description?: string | null;
  collection_uid?: string | null;
  created_at?: number | string | null;
  // Set once the worker has embedded it.
  processed?: boolean;
  embedded?: boolean;
}

function isoOrNull(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // Epoch millis from this service; ISO strings from others.
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function toCollection(raw: RawCollection): Collection {
  return {
    uid: raw.uid,
    name: raw.name ?? "",
    description: raw.description ?? null,
    fileCount: raw.file_count ?? 0,
    createdAt: isoOrNull(raw.created_at),
    updatedAt: isoOrNull(raw.updated_at),
  };
}

function toDocument(raw: RawDocument): KnowledgeDocument {
  return {
    uid: raw.uid,
    name: raw.name ?? "",
    type: raw.type ?? null,
    description: raw.description ?? null,
    collectionUid: raw.collection_uid ?? null,
    createdAt: isoOrNull(raw.created_at),
  };
}

/**
 * Unwrap `{data: …}`, tolerating a bare array from an older install.
 *
 * An envelope is recognised by its own marker fields, not by `data` alone: a
 * zero-count response omits `data` entirely, and keying off its presence then
 * returns the envelope object itself — so the caller's `.map()` throws
 * "map is not a function" on what is simply an empty result.
 */
function unwrap<T>(response: Envelope<T> | T): T {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    const isEnvelope =
      "data" in record || ("status" in record && "timestamp" in record);
    if (isEnvelope) return (record["data"] ?? []) as T;
  }
  return response as T;
}

export class Knowledge {
  constructor(private readonly transport: Transport) {}

  async listCollections(): Promise<Collection[]> {
    const raw = await this.transport.request<Envelope<RawCollection[]>>({
      path: "/api/v1/collections",
    });
    return (unwrap(raw) ?? []).map(toCollection);
  }

  async listDocuments(options: { collection?: UUID; limit?: number } = {}): Promise<
    KnowledgeDocument[]
  > {
    const raw = await this.transport.request<Envelope<RawDocument[]>>({
      path: "/api/v1/documents",
      query: { collection_uid: options.collection, limit: options.limit },
    });
    return (unwrap(raw) ?? []).map(toDocument);
  }

  /**
   * Upload a file into a collection.
   *
   * Returns as soon as the file is accepted. It is NOT searchable yet — the
   * worker still has to split, embed and index it. Follow with
   * `waitForProcessing()` if the next thing you do is query.
   */
  async upload(
    file: Blob | File,
    options: { collection: UUID; name?: string },
  ): Promise<KnowledgeDocument> {
    const form = new FormData();
    const filename = options.name ?? (file instanceof File ? file.name : "upload");
    form.append("file", file, filename);
    form.append("collection_uid", options.collection);

    // Multipart: `rawBody` so fetch sets the boundary itself. An upload is
    // also never retried — a repeat would ingest the file twice.
    const response = await this.transport.raw({
      method: "POST",
      path: "/api/v1/documents/upload",
      rawBody: form,
      idempotent: false,
      stream: true,
    });
    const raw = (await response.json()) as Envelope<RawDocument> | RawDocument;
    return toDocument(unwrap(raw) as RawDocument);
  }

  /** Search the corpus directly, without going through a conversation. */
  async search(
    query: string,
    options: { collections?: UUID[]; limit?: number } = {},
  ): Promise<KnowledgeDocument[]> {
    const raw = await this.transport.request<Envelope<RawDocument[]>>({
      method: "POST",
      path: "/api/v1/conversations/similarity-search",
      body: {
        query,
        collections: options.collections ?? [],
        limit: options.limit ?? 8,
      },
    });
    return (unwrap(raw) ?? []).map(toDocument);
  }

  /**
   * Poll until a document is embedded, or give up.
   *
   * There is no push signal for this, so polling is the honest answer rather
   * than a workaround. Returns true when it is ready, false on timeout.
   */
  async waitForProcessing(
    uid: UUID,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const timeout = options.timeoutMs ?? 120_000;
    const interval = options.intervalMs ?? 2_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const raw = await this.transport.request<Envelope<RawDocument> | RawDocument>({
        path: `/api/v1/documents/${uid}`,
      });
      const doc = unwrap(raw) as RawDocument | undefined;
      if (doc?.processed || doc?.embedded) return true;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return false;
  }
}
