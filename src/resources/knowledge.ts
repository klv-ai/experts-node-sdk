/**
 * Knowledge — the corpus experts retrieve from.
 *
 * Served by the embedding module rather than the conversations service, which
 * shows in the wire format: every response is wrapped in
 * `{timestamp, status, message, count, data}` and the rows inside are
 * snake_case. Unwrapped here so callers see the same shape as everywhere else.
 *
 * Uploading is asynchronous. A file is accepted into an indexing JOB, then
 * split, embedded and indexed by a worker — so a file that has just uploaded
 * is NOT yet retrievable, and the upload's answer is the job, not a document.
 * The job's status is where the document's uid appears, and where a file that
 * could not be read says why. `waitForProcessing()` is the honest way to
 * sequence an ingest.
 */

import type { Transport } from "../http.js";
import type {
  Collection,
  KnowledgeDocument,
  SearchHit,
  UploadedFile,
  UploadJob,
  UploadStatus,
  UUID,
} from "../types.js";

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
  min_role_id?: number;
  is_public?: boolean;
  scope_uids?: string[] | null;
}

interface RawDocument {
  uid: string;
  doc_name?: string;
  doc_type?: string | null;
  title?: string | null;
  summary?: string | null;
  file_size?: number | null;
  created_at?: number | string | null;
}

interface RawHit {
  cosine_dist?: number;
  split_text?: string;
  text_split_uid?: string;
  source_doc_uid?: string;
  doc_name?: string;
  title?: string | null;
  summary?: string | null;
  page_number?: number | null;
  source_location?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  rerank_score?: number | null;
}

interface RawJobStatus {
  total_files?: number;
  queue?: {
    status_id?: number;
    object_uid?: string | null;
    object_name?: string;
    extra?: string | null;
  }[];
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
    minRoleId: raw.min_role_id ?? 2,
    isPublic: raw.is_public ?? false,
    scopeUids: raw.scope_uids ?? [],
  };
}

function toDocument(raw: RawDocument, collection: UUID | undefined): KnowledgeDocument {
  return {
    uid: raw.uid,
    name: raw.doc_name ?? "",
    type: raw.doc_type ?? null,
    description: raw.summary ?? null,
    // The row names no collection; keep the one it was listed from.
    collectionUid: collection ?? null,
    createdAt: isoOrNull(raw.created_at),
    title: raw.title ?? null,
    summary: raw.summary ?? null,
    size: raw.file_size ?? null,
  };
}

function toHit(raw: RawHit): SearchHit {
  const distance = raw.cosine_dist;
  return {
    text: raw.split_text ?? "",
    documentUid: raw.source_doc_uid ?? "",
    documentName: raw.doc_name ?? "",
    title: raw.title ?? null,
    summary: raw.summary ?? null,
    distance,
    similarity: typeof distance === "number" ? 1 - distance : undefined,
    pageNumber: raw.page_number ?? null,
    location: raw.source_location ?? null,
    startMs: raw.start_ms ?? null,
    endMs: raw.end_ms ?? null,
    rerankScore: raw.rerank_score ?? null,
    splitUid: raw.text_split_uid ?? null,
  };
}

// The job queue's status ids, as names a caller can read.
const STATUS: Record<number, UploadedFile["status"]> = {
  [-1]: "failed",
  0: "pending",
  1: "working",
  2: "searchable",
  3: "finished",
};

function toUploadStatus(jobId: number, raw: RawJobStatus | null): UploadStatus {
  const files: UploadedFile[] = (raw?.queue ?? []).map((q) => ({
    name: q.object_name ?? "",
    documentUid: q.object_uid ?? null,
    status: STATUS[q.status_id ?? 0] ?? "pending",
    error: q.extra || null,
  }));
  const searchable = (f: UploadedFile) => f.status === "searchable" || f.status === "finished";
  const failed = files.filter((f) => f.status === "failed");
  // Every file accounted for, and none still in the pipeline. "searchable"
  // counts as an end: the document answers searches while its summary is
  // still being written.
  const done =
    files.length > 0 &&
    files.length >= (raw?.total_files ?? 0) &&
    files.every((f) => searchable(f) || f.status === "failed");
  return {
    jobId,
    files,
    done,
    ready: done && failed.length === 0,
    documentUids: files
      .filter((f) => searchable(f) && f.documentUid)
      .map((f) => f.documentUid as UUID),
    failed,
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

  /**
   * Documents this credential may read, optionally in one collection.
   *
   * `search` matches the file name, title or summary — it is a filter, not a
   * semantic search; for that, use `search()`.
   */
  async listDocuments(
    options: { collection?: UUID; limit?: number; skip?: number; search?: string } = {},
  ): Promise<KnowledgeDocument[]> {
    const raw = await this.transport.request<Envelope<RawDocument[]>>({
      path: "/api/v1/documents",
      query: {
        collection: options.collection,
        limit: options.limit,
        skip: options.skip,
        searchTerm: options.search,
      },
    });
    return (unwrap(raw) ?? []).map((d) => toDocument(d, options.collection));
  }

  /**
   * Upload a file into a collection.
   *
   * Resolves as soon as the file is accepted, with the indexing job it joined.
   * It is NOT searchable yet — the worker still has to split, embed and index
   * it. Follow with `waitForProcessing()` if the next thing you do is query;
   * that is also where the new document's uid and any read failure come back.
   */
  async upload(file: Blob | File, options: { collection: UUID; name?: string }): Promise<UploadJob> {
    const form = new FormData();
    const filename = options.name ?? (file instanceof File ? file.name : "upload");
    // `files`, plural: the endpoint takes several in one job.
    form.append("files", file, filename);
    form.append("collection", options.collection);

    // Multipart: `rawBody` so fetch sets the boundary itself. An upload is
    // also never retried — a repeat would ingest the file twice.
    const raw = await this.transport.request<{ job_queue_run_id?: number; message?: string }>({
      method: "POST",
      path: "/api/v1/documents/job-queue-upload",
      rawBody: form,
      idempotent: false,
    });
    return { jobId: raw?.job_queue_run_id ?? 0, message: raw?.message ?? "" };
  }

  /** Where an upload's indexing job has got to, without waiting. */
  async uploadStatus(job: UploadJob | number): Promise<UploadStatus> {
    const jobId = typeof job === "number" ? job : job.jobId;
    // Not enveloped, unlike the rest of this service.
    const raw = await this.transport.request<RawJobStatus | null>({
      path: `/api/v1/documents/job-queue-status/${jobId}`,
    });
    return toUploadStatus(jobId, raw);
  }

  /**
   * Poll until every file in the job is searchable or has failed.
   *
   * Resolves with the last status either way: `ready` when every file is
   * searchable; check `done` and `failed` to tell a failure from a timeout.
   * There is no push signal for this, so polling is the honest answer rather
   * than a workaround.
   *
   * Large files take longer than the default allows, and a recording is
   * transcribed before it becomes a document at all — raise `timeoutMs` for
   * those.
   */
  async waitForProcessing(
    job: UploadJob | number,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<UploadStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    const interval = options.intervalMs ?? 2_000;
    while (true) {
      const status = await this.uploadStatus(job);
      if (status.done || Date.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /**
   * The passages that best match `query`, closest first.
   *
   * Searches every collection this credential may read unless `collections`
   * narrows it.
   */
  async search(
    query: string,
    options: { collections?: UUID[]; limit?: number } = {},
  ): Promise<SearchHit[]> {
    const body: Record<string, unknown> = { prompt: query, top_k: options.limit ?? 8 };
    // Only when there are some. An empty list is not "everything": the
    // service turns it into a query that fails.
    if (options.collections?.length) body["collections"] = options.collections;
    const raw = await this.transport.request<Envelope<RawHit[]>>({
      method: "POST",
      // The trailing slash is part of the route.
      path: "/api/v1/similarity_search/",
      body,
    });
    return (unwrap(raw) ?? []).map(toHit);
  }

  /** Delete a document, from every collection it is in. */
  async deleteDocument(uid: UUID): Promise<void> {
    // Not retried: a repeat after a delete that did land answers 404.
    await this.transport.request({
      method: "DELETE",
      path: `/api/v1/documents/${uid}`,
      idempotent: false,
    });
  }
}
