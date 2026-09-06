/**
 * Conversations, and sending a message.
 *
 * `send()` is the reason this SDK exists. On the raw API, one chat turn is
 * THREE calls in a specific order, and getting it wrong fails silently rather
 * than loudly:
 *
 *   POST /api/v1/responses          the user's turn      {agent: false, done: true}
 *   POST /api/v1/responses          assistant placeholder {agent: true, done: false}
 *   POST /api/v1/conversations/chat {response: <placeholder uid>, ...}
 *
 * `/chat` never creates message rows — it UPDATES the placeholder you made.
 * Skip the first two calls and the model still answers and the stream still
 * looks fine, but nothing is persisted and every event carries an empty
 * `response`, so the conversation is empty when you reload it. That is the
 * single most expensive thing to discover by yourself, and it is why this
 * method exists.
 */

import type { Transport } from "../http.js";
import { ChatStream, readNdjson } from "../stream.js";
import { ExpertsStreamError } from "../errors.js";
import type {
  Conversation,
  ConversationWithMessages,
  Message,
  SendOptions,
  SourceDocument,
  UUID,
} from "../types.js";

interface RawConversation {
  uid: string;
  title?: string;
  model?: string | null;
  initialQuestion?: string;
  modelProfile?: string | null;
  active?: boolean;
  hidden?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  forkedFrom?: string | null;
  forkedByName?: string | null;
  messages?: RawMessage[];
}

interface RawMessage {
  uid: string;
  agent?: boolean;
  text?: string;
  question?: string | null;
  done?: boolean;
  index?: number;
  created_at?: string | null;
  source_docs?: unknown[];
  error?: string | null;
  aborted?: boolean;
}

function toConversation(raw: RawConversation): Conversation {
  return {
    uid: raw.uid,
    title: raw.title ?? "",
    model: raw.model ?? null,
    initialQuestion: raw.initialQuestion ?? "",
    expertUid: raw.modelProfile ?? null,
    active: raw.active ?? true,
    hidden: raw.hidden ?? false,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    forkedFrom: raw.forkedFrom ?? null,
    forkedByName: raw.forkedByName ?? null,
  };
}

// Message rows arrive snake_case from a raw SQL projection, unlike the
// conversation row wrapping them. Normalised here so callers see one style.
function toMessage(raw: RawMessage): Message {
  return {
    uid: raw.uid,
    agent: raw.agent ?? true,
    text: raw.text ?? "",
    question: raw.question ?? null,
    done: raw.done ?? true,
    index: raw.index ?? 0,
    createdAt: raw.created_at ?? null,
    sourceDocs: (raw.source_docs ?? []) as SourceDocument[],
    error: raw.error ?? null,
    aborted: raw.aborted ?? false,
  };
}

export interface CreateConversationOptions {
  expert?: UUID;
  title?: string;
  model?: string;
  initialQuestion?: string;
  /** Keep this conversation out of list views. */
  hidden?: boolean;
}

export interface ListConversationOptions {
  skip?: number;
  /** Server caps this at 100. */
  limit?: number;
  active?: boolean;
}

export interface ForkOptions {
  title?: string;
  /** Branch point: copy messages up to and including this response. */
  responseUid?: UUID;
  /** Fork into another user's account. The source stays with the caller. */
  targetUser?: UUID;
}

export class Conversations {
  constructor(private readonly transport: Transport) {}

  async create(options: CreateConversationOptions = {}): Promise<Conversation> {
    const raw = await this.transport.request<RawConversation>({
      method: "POST",
      path: "/api/v1/conversations/start",
      body: {
        title: options.title ?? "",
        // The server requires the field; an expert's own model wins anyway.
        model: options.model ?? "",
        initialQuestion: options.initialQuestion ?? "",
        configId: 1,
        modelProfile: options.expert,
        hidden: options.hidden ?? false,
      },
    });
    return toConversation(raw);
  }

  async list(options: ListConversationOptions = {}): Promise<Conversation[]> {
    const raw = await this.transport.request<RawConversation[]>({
      // The trailing slash matters: without it the gateway answers a 307.
      path: "/api/v1/conversations/",
      query: {
        skip: options.skip ?? 0,
        limit: options.limit ?? 50,
        active: options.active ?? true,
      },
    });
    return (raw ?? []).map(toConversation);
  }

  async get(uid: UUID): Promise<ConversationWithMessages> {
    const raw = await this.transport.request<RawConversation>({
      path: `/api/v1/conversations/${uid}`,
    });
    return { ...toConversation(raw), messages: (raw.messages ?? []).map(toMessage) };
  }

  async update(uid: UUID, changes: { title?: string; model?: string }): Promise<Conversation> {
    const raw = await this.transport.request<RawConversation>({
      method: "PUT",
      path: "/api/v1/conversations/",
      body: { uid, ...changes },
    });
    return toConversation(raw);
  }

  /** Soft delete — the row is deactivated, not destroyed. */
  async delete(uid: UUID): Promise<void> {
    // A body-bearing DELETE. Unusual, but it is what the API takes.
    await this.transport.request({
      method: "DELETE",
      path: "/api/v1/conversations/",
      body: { uid },
    });
  }

  async fork(uid: UUID, options: ForkOptions = {}): Promise<Conversation> {
    const raw = await this.transport.request<RawConversation>({
      method: "POST",
      path: `/api/v1/conversations/${uid}/fork`,
      body: {
        title: options.title ?? null,
        responseUid: options.responseUid ?? null,
        targetUser: options.targetUser ?? null,
      },
    });
    return toConversation(raw);
  }

  /** A suggested name for a fork, generated from the transcript. */
  async suggestForkTitle(uid: UUID): Promise<string> {
    const raw = await this.transport.request<{ title: string }>({
      method: "POST",
      path: `/api/v1/conversations/${uid}/fork/title`,
    });
    return raw.title;
  }

  /**
   * Send a message and stream the reply.
   *
   * Wraps the three-call sequence described at the top of this file. The
   * returned stream is async-iterable for events and awaitable via `.text()`.
   */
  async send(
    conversationUid: UUID,
    question: string,
    options: SendOptions & { expert?: UUID; model?: string } = {},
  ): Promise<ChatStream> {
    // 1. The user's turn, already settled.
    await this.transport.request({
      method: "POST",
      path: "/api/v1/responses/",
      body: {
        text: question,
        conversation: conversationUid,
        agent: false,
        done: true,
        question: "",
        images: options.images ?? [],
        context: options.context ?? [],
      },
      // Never retried: a duplicate here posts the question twice.
      idempotent: false,
    });

    // 2. The assistant placeholder. Its uid is what /chat writes into, and
    //    what makes cancelling possible.
    const placeholder = await this.transport.request<{ uid: string }>({
      method: "POST",
      path: "/api/v1/responses/",
      body: {
        text: "",
        conversation: conversationUid,
        agent: true,
        done: false,
        question,
        profileId: options.expert,
        context: [],
      },
      idempotent: false,
    });

    // 3. Generate. Streams NDJSON over plain HTTP.
    const response = await this.transport.raw({
      method: "POST",
      path: "/api/v1/conversations/chat",
      body: {
        conversationUid,
        question,
        response: placeholder.uid,
        expert: options.expert,
        model: options.model,
        images: options.images,
        context: options.context,
      },
      stream: true,
      signal: options.signal,
      headers: { accept: "application/x-ndjson" },
    });

    if (!response.body) {
      throw new ExpertsStreamError("The server returned no response body");
    }

    return new ChatStream({
      events: readNdjson(response.body),
      conversationUid,
      responseUid: placeholder.uid,
      cancelFn: async (responseUid) => {
        if (!responseUid) return;
        await this.transport.request({
          method: "POST",
          path: `/api/v1/conversations/chat/${responseUid}/cancel`,
          idempotent: false,
        });
      },
    });
  }

  /** Create a conversation and send the first message in one call. */
  async ask(
    question: string,
    options: SendOptions & { expert?: UUID; model?: string; title?: string } = {},
  ): Promise<ChatStream> {
    const conversation = await this.create({
      expert: options.expert,
      model: options.model,
      title: options.title ?? "",
      initialQuestion: question,
    });
    return this.send(conversation.uid, question, options);
  }
}
