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
  /** The persona/system prompt. `modelfile` on the wire. */
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
   * Load-bearing for browser sessions: a session token is a guest, and an
   * expert above that floor silently resolves to the site default model with
   * no persona. `sessions.create()` refuses such an expert up front.
   */
  minRoleId: number;
  private: boolean;
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
   * The end.
   *
   * Carries no content on purpose: on the tool path the text already streamed,
   * so a terminal chunk with content would render the answer twice.
   */
  | {
      type: "done";
      finishReason: string;
      usage: Usage;
      sourceDocs: SourceDocument[];
      toolsUsed: string[];
      aborted: boolean;
      error?: string;
      contextOverflow: boolean;
      responseUid?: string;
    };

export interface ChatResult {
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
  fileCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface KnowledgeDocument {
  uid: UUID;
  name: string;
  type: string | null;
  description: string | null;
  collectionUid: UUID | null;
  createdAt: string | null;
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
