/**
 * Reading the chat stream.
 *
 * Every case here corresponds to something that actually goes wrong when a
 * caller hand-rolls this against the raw API, which is most of the reason the
 * SDK exists at all.
 */

import { describe, expect, it } from "vitest";

import { readNdjson, toEvent } from "../src/stream.js";

/** A body that hands over exactly the chunks given, boundaries included. */
function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const event of readNdjson(body)) out.push(event);
  return out;
}

describe("NDJSON framing", () => {
  it("reads one event per line", async () => {
    const events = await collect(bodyOf('{"a":1}\n{"a":2}\n'));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("carries an incomplete line across a chunk boundary", async () => {
    // The single most common hand-rolled bug: a chunk boundary lands
    // mid-JSON, and splitting on "\n" discards the remainder. It shows up as
    // occasional dropped tokens, which looks like a model problem.
    const events = await collect(bodyOf('{"message":{"con', 'tent":"hi"}}\n'));
    expect(events).toEqual([{ message: { content: "hi" } }]);
  });

  it("survives a boundary that falls inside a multi-byte character", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"c":"né"}\n');
    const split = 8; // mid "é"
    const events = await collect(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      }),
    );
    expect(events).toEqual([{ c: "né" }]);
  });

  it("emits a final line that arrived without a trailing newline", async () => {
    expect(await collect(bodyOf('{"a":1}'))).toEqual([{ a: 1 }]);
  });

  it("skips an unparseable line rather than failing the whole answer", async () => {
    const events = await collect(bodyOf('{"a":1}\nnot json\n{"a":2}\n'));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("ignores blank lines", async () => {
    expect(await collect(bodyOf('\n\n{"a":1}\n\n'))).toEqual([{ a: 1 }]);
  });
});

describe("event mapping", () => {
  it("maps content to a token event", () => {
    expect(toEvent({ type: "stream", message: { content: "Hi" }, done: false })).toEqual({
      type: "token",
      content: "Hi",
      responseUid: undefined,
    });
  });

  it("keeps thinking separate from the answer", () => {
    expect(toEvent({ type: "thinking", message: { content: "hmm" } })).toEqual({
      type: "thinking",
      content: "hmm",
    });
  });

  it("surfaces a keepalive without content", () => {
    // Never content: it is a heartbeat, and appending it would inject empty
    // strings into the answer.
    expect(toEvent({ type: "keepalive", message: { content: "" } })).toEqual({
      type: "keepalive",
    });
  });

  it("drops an empty non-terminal chunk", () => {
    expect(toEvent({ type: "stream", message: { content: "" }, done: false })).toBeNull();
  });

  it("does not put content on the terminal event", () => {
    // On the tool path the terminal chunk is empty BY DESIGN — the text
    // already streamed. A `content` field here invites double-rendering.
    const event = toEvent({
      type: "stream",
      message: { content: "" },
      done: true,
      done_reason: "stop",
    });
    expect(event).not.toHaveProperty("content");
    expect(event?.type).toBe("done");
  });
});

describe("terminal event", () => {
  const terminal = {
    type: "stream",
    message: { content: "" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 100,
    eval_count: 20,
    total_duration: 5_000_000_000,
    eval_duration: 3_000_000_000,
    source_docs: [{ uid: "d1", name: "n", title: "t", type: ".pdf", text: "x", description: "", cosine_dist: 0.25 }],
    tools_used: ["web_search"],
  };

  it("converts nanosecond durations to milliseconds", () => {
    // Ollama's units, passed straight through by the API. Nobody expects
    // nanoseconds, so they are normalised once here.
    const event = toEvent(terminal);
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.usage.totalMs).toBe(5000);
    expect(event.usage.evalMs).toBe(3000);
  });

  it("totals tokens", () => {
    const event = toEvent(terminal);
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it("exposes similarity alongside distance", () => {
    // "distance" ranks backwards — lower is better — which is a reliable
    // source of inverted relevance sorting.
    const event = toEvent(terminal);
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.sourceDocs[0]).toMatchObject({ distance: 0.25, similarity: 0.75 });
  });

  it("carries tools used", () => {
    const event = toEvent(terminal);
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.toolsUsed).toEqual(["web_search"]);
  });

  it("surfaces an error reported inside a 200 response", () => {
    // The stream returns HTTP 200 and then reports trouble in its terminal
    // event. A caller checking only the status sees an empty answer and no
    // reason at all.
    const event = toEvent({ ...terminal, error: "model unreachable" });
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.error).toBe("model unreachable");
  });

  it("reports a context overflow as such", () => {
    const event = toEvent({ ...terminal, context_overflow: true });
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.contextOverflow).toBe(true);
  });

  it("copes with a terminal event carrying no counters", () => {
    const event = toEvent({ done: true, message: { content: "" } });
    if (event?.type !== "done") throw new Error("expected done");
    expect(event.usage.totalTokens).toBe(0);
    expect(event.sourceDocs).toEqual([]);
  });
});

describe("mesh", () => {
  // Experts Mesh (build pack 1.1): who answered, and waiting in line.
  const done = { type: "stream", message: { content: "" }, done: true };

  it("makes waiting in line its own event, not content", () => {
    expect(
      toEvent({ type: "mesh_waiting", node: "n-tokyo", name: "Tokyo", ahead: 2, done: false, response: "r" }),
    ).toEqual({ type: "queued", ahead: 2, node: "n-tokyo", name: "Tokyo", rerouting: false });
  });

  it("flags a reroute", () => {
    const event = toEvent({ type: "mesh_waiting", name: "Tokyo", ahead: 0, rerouting: true, done: false });
    expect(event).toMatchObject({ type: "queued", rerouting: true });
  });

  it("names another member's model", () => {
    const event = toEvent({
      ...done,
      model: "gemma4:12b",
      served_by: {
        node: "n-tokyo",
        name: "Tokyo",
        label: "Tokyo GPU",
        model: "gemma4:12b",
        route: [
          { node: "n-lis", name: "Lisbon" },
          { node: "n-tokyo", name: "Tokyo" },
        ],
      },
    });
    expect(event).toMatchObject({
      type: "done",
      model: "gemma4:12b",
      servedBy: { name: "Tokyo", route: ["Lisbon", "Tokyo"] },
    });
  });

  it("says what was out of reach on a fallback", () => {
    const event = toEvent({
      ...done,
      mesh_fallback: { node: "n-chi", name: "Chicago", model: "llama3:70b", reason: "unreachable", answered_with: "gemma4:12b" },
    });
    expect(event).toMatchObject({
      meshFallback: { name: "Chicago", reason: "unreachable", answeredWith: "gemma4:12b" },
    });
  });

  it("carries a strict expert's unreachable model as an error", () => {
    const event = toEvent({ ...done, error: "Chicago is unreachable", mesh_unavailable: { name: "Chicago" } });
    expect(event).toMatchObject({ error: "Chicago is unreachable", meshUnavailable: { name: "Chicago" } });
  });
});

describe("tool outputs", () => {
  it("carries data artifacts and generated images", () => {
    const event = toEvent({
      type: "stream",
      message: { content: "" },
      done: true,
      data_artifacts: [{ id: "a1", kind: "chart" }, "junk"],
      generated_images: [{ url: "/img/1.png" }],
    });
    expect(event).toMatchObject({
      dataArtifacts: [{ id: "a1", kind: "chart" }],
      generatedImages: [{ url: "/img/1.png" }],
    });
  });

  it("keeps a cited recording passage's time", () => {
    const event = toEvent({
      type: "stream",
      message: { content: "" },
      done: true,
      source_docs: [{ uid: "d", name: "call.m4a", cosine_dist: 0.2, split_uid: "s-9", start_ms: 61000, end_ms: 64500 }],
    });
    expect(event).toMatchObject({ sourceDocs: [{ splitUid: "s-9", startMs: 61000, endMs: 64500 }] });
  });
});
