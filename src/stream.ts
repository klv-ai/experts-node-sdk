/**
 * Reading the chat stream.
 *
 * The wire format is newline-delimited JSON over plain HTTP — no WebSocket is
 * involved, contrary to a well-travelled note in this codebase's history. Each
 * line is one event; the last one carries `done: true`.
 *
 * Four things here are easy to get wrong by hand, and all four have bitten
 * somebody:
 *
 * 1. **Keep the incomplete trailing line.** A chunk boundary falls wherever
 *    TCP puts it, routinely mid-JSON. Splitting on "\n" and discarding the
 *    remainder drops a token every few hundred; the buffer below carries it
 *    into the next read.
 *
 * 2. **The terminal chunk of a tool-assisted answer has EMPTY content on
 *    purpose.** The text already streamed token by token. Appending it again
 *    renders every tool-using answer twice.
 *
 * 3. **Durations are nanoseconds.** Ollama's units, passed straight through.
 *    Normalised to milliseconds once, here, rather than in every caller.
 *
 * 4. **Disconnecting is not cancelling.** Generation is detached from the HTTP
 *    request server-side: dropping the connection stops the relay, not the
 *    model. It keeps generating, persists its answer, and keeps publishing to
 *    the conversation's event stream. `cancel()` calls the cancel endpoint;
 *    `detach()` is the deliberate "leave it running" case.
 */

import type {
  AnswerDetails,
  ChatEvent,
  ChatResult,
  MeshFallback,
  ServedBy,
  SourceDocument,
  Usage,
} from "./types.js";
import { ExpertsAbortError, ExpertsError, ExpertsStreamError } from "./errors.js";

/** Split a byte stream into NDJSON events, preserving partial lines. */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // The last element is whatever arrived after the final newline — it may
      // be half an object, so it stays in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = tryParse(trimmed);
        // A line that will not parse is skipped rather than fatal: one
        // corrupt event must not discard an answer that is otherwise fine.
        if (parsed) yield parsed;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = tryParse(tail);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const NS_PER_MS = 1_000_000;

function ms(value: unknown): number | undefined {
  return typeof value === "number" ? Math.round(value / NS_PER_MS) : undefined;
}

function usageFrom(raw: Record<string, unknown>): Usage {
  const promptTokens = numberOr(raw["prompt_eval_count"], 0);
  const completionTokens = numberOr(raw["eval_count"], 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    reasoningTokens: numberOrUndefined(raw["reasoning_tokens"]),
    // Nanoseconds on the wire. Nobody expects those.
    totalMs: ms(raw["total_duration"]),
    promptMs: ms(raw["prompt_eval_duration"]),
    evalMs: ms(raw["eval_duration"]),
    loadMs: ms(raw["load_duration"]),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Source documents as the SDK shapes them, from a done event or a message row. */
export function sourceDocs(raw: unknown): SourceDocument[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((doc: Record<string, unknown>) => ({
    uid: String(doc["uid"] ?? ""),
    name: String(doc["name"] ?? ""),
    title: String(doc["title"] ?? ""),
    type: String(doc["type"] ?? ""),
    text: String(doc["text"] ?? ""),
    description: String(doc["description"] ?? ""),
    // Lower is closer. Exposed as similarity too, because "distance" reads
    // backwards to anyone ranking results.
    distance: numberOrUndefined(doc["cosine_dist"]),
    similarity:
      typeof doc["cosine_dist"] === "number" ? 1 - doc["cosine_dist"] : undefined,
    splitUid: stringOrUndefined(doc["split_uid"]),
    startMs: numberOrUndefined(doc["start_ms"]),
    endMs: numberOrUndefined(doc["end_ms"]),
  }));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function servedBy(raw: unknown): ServedBy | undefined {
  const r = record(raw);
  if (!r) return undefined;
  return {
    node: String(r["node"] ?? ""),
    name: String(r["name"] ?? ""),
    label: String(r["label"] ?? ""),
    model: String(r["model"] ?? ""),
    route: Array.isArray(r["route"])
      ? (r["route"] as unknown[])
          .map(record)
          .filter((hop): hop is Record<string, unknown> => hop !== undefined)
          .map((hop) => String(hop["name"] ?? hop["node"] ?? ""))
      : [],
  };
}

function meshFallback(raw: unknown): MeshFallback | undefined {
  const r = record(raw);
  if (!r) return undefined;
  return {
    node: String(r["node"] ?? ""),
    name: String(r["name"] ?? ""),
    model: String(r["model"] ?? ""),
    reason: String(r["reason"] ?? ""),
    answeredWith: String(r["answered_with"] ?? ""),
  };
}

/** Who answered, and what tools produced, from a terminal event. */
function answerDetails(raw: Record<string, unknown>): AnswerDetails {
  return {
    model: stringOrUndefined(raw["model"]),
    servedBy: servedBy(raw["served_by"]),
    meshFallback: meshFallback(raw["mesh_fallback"]),
    meshUnavailable: record(raw["mesh_unavailable"]),
    generatedImages: Array.isArray(raw["generated_images"])
      ? (raw["generated_images"] as unknown[])
      : [],
    dataArtifacts: Array.isArray(raw["data_artifacts"])
      ? (raw["data_artifacts"] as unknown[])
          .map(record)
          .filter((a): a is Record<string, unknown> => a !== undefined)
      : [],
  };
}

/** Turn one raw NDJSON event into the SDK's typed union, or null to skip it. */
export function toEvent(raw: Record<string, unknown>): ChatEvent | null {
  const type = raw["type"];
  const content = ((raw["message"] as Record<string, unknown>)?.["content"] ?? "") as string;

  if (type === "keepalive") {
    // Heartbeat while the server is thinking or running a tool preflight.
    // Surfaced so a UI can keep a spinner honest, never as content.
    return { type: "keepalive" };
  }
  if (type === "thinking") {
    return { type: "thinking", content };
  }
  if (type === "mesh_waiting") {
    // Waiting in line for another mesh member's model. Live only, never
    // stored, and never content.
    return {
      type: "queued",
      ahead: numberOr(raw["ahead"], 0),
      node: stringOrUndefined(raw["node"]),
      name: stringOrUndefined(raw["name"]),
      rerouting: raw["rerouting"] === true,
    };
  }
  if (type === "action") {
    const detail = (raw["detail"] ?? {}) as Record<string, unknown>;
    return {
      type: "action",
      action: String(raw["action"] ?? ""),
      status: String(raw["status"] ?? ""),
      detail,
    };
  }

  if (raw["done"] === true) {
    return {
      type: "done",
      // Deliberately NOT `content`. On the tool path the terminal chunk is
      // empty by design because the text already streamed; anyone appending
      // it renders tool-using answers twice.
      finishReason: String(raw["done_reason"] ?? "stop"),
      usage: usageFrom(raw),
      sourceDocs: sourceDocs(raw["source_docs"]),
      toolsUsed: Array.isArray(raw["tools_used"]) ? (raw["tools_used"] as string[]) : [],
      aborted: raw["aborted"] === true,
      error: typeof raw["error"] === "string" && raw["error"] ? raw["error"] : undefined,
      contextOverflow: raw["context_overflow"] === true,
      responseUid: stringOrUndefined(raw["response"]),
      ...answerDetails(raw),
    };
  }

  if (!content) return null;
  return { type: "token", content, responseUid: stringOrUndefined(raw["response"]) };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export interface ChatStreamInit {
  events: AsyncGenerator<Record<string, unknown>>;
  /**
   * Stops the model server-side. Distinct from merely disconnecting. Resolves
   * true when the server found it running and stopped it.
   */
  cancelFn: (responseUid: string | undefined) => Promise<boolean>;
  conversationUid: string;
  responseUid: string | undefined;
}

/**
 * A live answer.
 *
 * Async-iterable for typed events, awaitable via `text()` for the whole reply,
 * and cancellable for real.
 */
export class ChatStream implements AsyncIterable<ChatEvent> {
  readonly conversationUid: string;
  /** The assistant message row this answer is being written into. */
  readonly responseUid: string | undefined;

  private readonly init: ChatStreamInit;
  private consumed = false;
  private cancelled = false;
  private detached = false;
  private result: ChatResult | null = null;

  constructor(init: ChatStreamInit) {
    this.init = init;
    this.conversationUid = init.conversationUid;
    this.responseUid = init.responseUid;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatEvent> {
    if (this.consumed) {
      throw new ExpertsStreamError("This stream has already been consumed");
    }
    this.consumed = true;

    let text = "";
    let reasoning = "";
    let sawDone = false;

    try {
      for await (const raw of this.init.events) {
        const event = toEvent(raw);
        if (!event) continue;

        if (event.type === "token") text += event.content;
        if (event.type === "thinking") reasoning += event.content;

        if (event.type === "done") {
          sawDone = true;
          this.result = {
            text,
            reasoning,
            conversationUid: this.conversationUid,
            responseUid: event.responseUid ?? this.responseUid,
            usage: event.usage,
            sourceDocs: event.sourceDocs,
            toolsUsed: event.toolsUsed,
            finishReason: event.finishReason,
            aborted: event.aborted,
            error: event.error,
            model: event.model,
            servedBy: event.servedBy,
            meshFallback: event.meshFallback,
            meshUnavailable: event.meshUnavailable,
            generatedImages: event.generatedImages,
            dataArtifacts: event.dataArtifacts,
          };
          yield event;
          return;
        }
        yield event;
      }
    } catch (cause) {
      // A dropped connection mid-answer surfaces from fetch as a bare
      // TypeError ("terminated"). Raised as the SDK's own error, with what
      // recovery looks like — unless the caller stopped on purpose.
      if (this.cancelled || this.detached) return;
      if (cause instanceof ExpertsError) throw cause;
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new ExpertsAbortError("The request was cancelled", { cause });
      }
      throw incomplete(cause);
    }

    if (!sawDone && !this.cancelled && !this.detached) throw incomplete();
  }

  /** Consume the whole stream and return the finished answer. */
  async result_(): Promise<ChatResult> {
    if (this.result) return this.result;
    for await (const _ of this) {
      // Draining is the point; the terminal event populates `result`.
    }
    if (!this.result) throw new ExpertsStreamError("The stream produced no result");
    return this.result;
  }

  /** Convenience: the assistant's reply as a string. */
  async text(): Promise<string> {
    return (await this.result_()).text;
  }

  /**
   * Stop the model. Resolves true when the server found it running and
   * stopped it.
   *
   * Not the same as walking away from the stream: generation is detached
   * server-side, so an abandoned request keeps generating, keeps billing and
   * still persists its answer. This is the only thing that actually stops it.
   *
   * False means the server had nothing to stop: the answer had already
   * finished, or — behind a load balancer with several conversation workers —
   * it is running on another one.
   */
  async cancel(): Promise<boolean> {
    this.cancelled = true;
    return this.init.cancelFn(this.responseUid);
  }

  /**
   * Stop reading, deliberately leaving the answer to finish server-side.
   *
   * For "the user navigated away but should see the reply when they come
   * back" — the answer persists and can be read from the conversation later.
   */
  detach(): void {
    this.detached = true;
  }
}

function incomplete(cause?: unknown): ExpertsStreamError {
  // The answer very likely completed on the server regardless — generation is
  // detached — so say what recovery actually looks like.
  const how = cause instanceof Error ? ` (${cause.message})` : "";
  return new ExpertsStreamError(
    `The stream ended without a terminal event${how}. The answer may still have ` +
      "completed on the server: re-read the conversation rather than resending.",
    cause === undefined ? { code: "incomplete_stream" } : { code: "incomplete_stream", cause },
  );
}
