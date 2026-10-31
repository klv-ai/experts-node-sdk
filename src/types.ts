/**
 * Wire types.
 *
 * Naming note: the API is inconsistent by design, and this SDK is where that
 * stops. Conversation rows come back camelCased; message rows and expert rows
 * come back snake_case (`source_docs`, `min_role_id`); the knowledge service
 * wraps everything in `{timestamp, status, count, data}`. All three are
 * normalised here so a caller never has to know which service answered.
 */

export type UUID = string;

export interface Expert {
  uid: UUID;
  name: string;
  description: string | null;
  /**
   * The persona/system prompt. `modelfile` on the wire.
   *
   * Only the expert's owner and administrators see it (build pack 1.1); for
   * anyone else this is null.
   */
  instructions: string | null;
  model: string | null;
  avatar: string | null;
  /** Suggested opening questions, for a picker UI. */
  starters: string[];
  /** Knowledge collections this expert can retrieve from. */
  collections: UUID[];
  temperature: number | null;
  /** Voice id, when the install has speech enabled. */
  voice: string | null;
  outputLanguage: string | null;
  /**
   * Minimum role that may use this expert. 1 = guest.
   *
   * Load-bearing for browser sessions: a session token is a guest, and
   * `sessions.create()` refuses an expert above this floor up front. Chatting
   * with one is refused too (ExpertNotAvailableError); before build pack 1.1
   * it silently answered on the site default model instead.
   */
  minRoleId: number;
  private: boolean;
  /**
   * Org profiles this expert is limited to; empty means everyone who meets
   * `minRoleId`. A browser visitor belongs to none, so a limited expert cannot
   * back a chatbox.
   */
  scopeUids: UUID[];
}

export interface Conversation {
  uid: UUID;
  title: string;
  model: string | null;
  initialQuestion: string;
  /** Expert attached to this conversation, if any. */
  expertUid: UUID | null;
  active: boolean;
  /** Hidden conversations are excluded from list views, not from access. */
  hidden: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  forkedFrom: UUID | null;
  forkedByName: string | null;
}

export interface Message {
  uid: UUID;
  /** True for the assistant, false for the user. */
  agent: boolean;
  text: string;
  question: string | null;
  /** False while an answer is still being written. */
  done: boolean;
  index: number;
  createdAt: string | null;
  sourceDocs: SourceDocument[];
  error: string | null;
  aborted: boolean;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

export interface SourceDocument {
  uid: string;
  name: string;
  title: string;
  type: string;
  /** The retrieved passage, not the whole document. */
  text: string;
  description: string;
  /** Cosine distance — lower is closer. */
  distance?: number;
  /** `1 - distance`, because "distance" reads backwards when ranking. */
  similarity?: number;
  /** The passage that was cited, for opening a viewer at it. */
  splitUid?: string;
  /** For a recording: where in it the passage was said, in milliseconds. */
  startMs?: number;
  endMs?: number;
}

/** Another server's model answered (an Experts Mesh member). */
export interface ServedBy {
  node: string;
  /** The member's display name, e.g. "Tokyo". */
  name: string;
  label: string;
  model: string;
  /** The members the request passed through, in order, when it was relayed. */
  route: string[];
}

/**
 * The expert's own model was out of reach, so this server's answered.
 *
 * Only for an expert set to fall back; a strict one fails instead, with
 * `error` set and the details in `meshUnavailable`.
 */
export interface MeshFallback {
  /** The member whose model was out of reach. */
  node: string;
  name: string;
  model: string;
  /** "unreachable", or "not_shared" when that member stopped sharing it. */
  reason: string;
  /** The model that answered instead. */
  answeredWith: string;
}

/** Who answered, and what tools produced. On the done event and the result. */
export interface AnswerDetails {
  /** The model that answered. */
  model?: string;
  /** Set when another mesh member's model answered. */
  servedBy?: ServedBy;
  /** Set when the expert's own mesh model was out of reach. */
  meshFallback?: MeshFallback;
  /** A strict expert's mesh model was out of reach: what was unreachable. */
  meshUnavailable?: Record<string, unknown>;
  /** Images a tool generated for this answer. */
  generatedImages: unknown[];
  /**
   * Tables, charts and proposed sheet edits a tool produced, each with `id`
   * and `kind` ("query", "chart" or "sheet_proposal").
   */
  dataArtifacts: Record<string, unknown>[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  /** Milliseconds. The wire carries nanoseconds; converted once, in the SDK. */
  totalMs?: number;
  promptMs?: number;
  evalMs?: number;
  loadMs?: number;
}

export type ChatEvent =
  /** A piece of the answer. Concatenate these. */
  | { type: "token"; content: string; responseUid?: string }
  /** Reasoning tokens, when the model exposes them and the expert allows it. */
  | { type: "thinking"; content: string }
  /** Progress: retrieval, tool calls, compression. Useful for a status line. */
  | { type: "action"; action: string; status: string; detail: Record<string, unknown> }
  /** Heartbeat. Never content — surfaced so a spinner can stay honest. */
  | { type: "keepalive" }
  /**
   * Waiting in line for another server's model (an Experts Mesh member that
   * is busy), sent each time the place in line moves. Nothing streams while
   * it waits. `ahead` is 0 with `rerouting` when the request is being sent a
   * different way after a route failed. Never content.
   */
  | { type: "queued"; ahead: number; node?: string; name?: string; rerouting: boolean }
  /**
   * The end.
   *
   * Carries no content on purpose: on the tool path the text already streamed,
   * so a terminal chunk with content would render the answer twice.
   */
  | ({
      type: "done";
      finishReason: string;
      usage: Usage;
      sourceDocs: SourceDocument[];
      toolsUsed: string[];
      aborted: boolean;
      error?: string;
      contextOverflow: boolean;
      responseUid?: string;
    } & AnswerDetails);

export interface ChatResult extends AnswerDetails {
  text: string;
  /** Reasoning tokens, if any were streamed. */
  reasoning: string;
  conversationUid: UUID;
  responseUid?: string;
  usage: Usage;
  sourceDocs: SourceDocument[];
  toolsUsed: string[];
  finishReason: string;
  aborted: boolean;
  /**
   * Set when generation failed *inside* a 200 response.
   *
   * The stream returns HTTP 200 and then reports trouble in its terminal
   * event, so a caller checking only the status code sees an empty answer and
   * no reason. Always worth checking.
   */
  error?: string;
}

export interface Collection {
  uid: UUID;
  name: string;
  description: string | null;
  /**
   * Not reported by the API, so always 0. Kept so existing code does not
   * break; count with `listDocuments({ collection })` instead.
   */
  fileCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Minimum role that may read it, when it is public. */
  minRoleId: number;
  isPublic: boolean;
  /** Org profiles it is limited to; empty means no limit. */
  scopeUids: UUID[];
}

export interface KnowledgeDocument {
  uid: UUID;
  /** The file name, e.g. "policy.pdf". */
  name: string;
  /** The file type, e.g. "pdf". */
  type: string | null;
  /** The summary written after indexing. Same as `summary`. */
  description: string | null;
  /**
   * The collection it was listed from, when `listDocuments()` was filtered by
   * one. A document can sit in several, and its row names none.
   */
  collectionUid: UUID | null;
  createdAt: string | null;
  title: string | null;
  summary: string | null;
  /** Bytes. */
  size: number | null;
}

/** One passage that matched a search, with the document it came from. */
export interface SearchHit {
  /** The passage itself. */
  text: string;
  documentUid: UUID;
  documentName: string;
  title: string | null;
  summary: string | null;
  /** Cosine distance — lower is closer. */
  distance?: number;
  /** `1 - distance`. */
  similarity?: number;
  pageNumber: number | null;
  /** Where in the document, when the format has one (a slide, a sheet). */
  location: string | null;
  /** For a recording: where the passage was said, in milliseconds. */
  startMs: number | null;
  endMs: number | null;
  /** The reranker's score, when the install reranks. */
  rerankScore: number | null;
  /** The id of the passage. */
  splitUid: string | null;
}

/** An upload the server has accepted and queued for indexing. */
export interface UploadJob {
  /** Pass this object (or the id) to `waitForProcessing()` or `uploadStatus()`. */
  jobId: number;
  message: string;
}

/** One file in an indexing job. */
export interface UploadedFile {
  name: string;
  /** The document's uid, once the server has made one. */
  documentUid: UUID | null;
  /**
   * "searchable" means embedded and answering searches while its summary is
   * still being written.
   */
  status: "pending" | "working" | "searchable" | "finished" | "failed";
  error: string | null;
}

/** Where an indexing job has got to. */
export interface UploadStatus {
  jobId: number;
  files: UploadedFile[];
  /** Every file has finished one way or the other: searchable or failed. */
  done: boolean;
  /** Every file is searchable. */
  ready: boolean;
  /** Uids of the documents that are searchable. */
  documentUids: UUID[];
  /** Files that could not be read, each with why. */
  failed: UploadedFile[];
}

export interface BrowserSession {
  /** Hand this to the browser. Never the API key. */
  token: string;
  /** Revocation handle. Pass to `sessions.revoke()`. */
  sessionId: string;
  expiresIn: number;
  conversation: UUID;
  expert: { uid: UUID; name: string; avatar: string | null; description: string | null };
}

export interface SendOptions {
  /** Base64 data URIs or image references, for a vision-capable model. */
  images?: string[];
  /** Knowledge context keys to pin to this turn. */
  context?: string[];
  signal?: AbortSignal;
}
