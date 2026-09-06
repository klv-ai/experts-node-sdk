# @klv-ai/experts

The official Node/TypeScript SDK for the [Klavi Experts](https://github.com/klv-ai) API — AI experts with retrieval over your own documents, running on your own infrastructure.

Zero dependencies. ESM and CommonJS. Node 22+.

```bash
npm install @klv-ai/experts
```

## Thirty seconds

```ts
import { ExpertsClient } from "@klv-ai/experts";

const experts = new ExpertsClient({
  baseUrl: "https://experts.acme.com",
  apiKey: process.env.EXPERTS_API_KEY!,   // server-side only
});

const stream = await experts.conversations.ask("What's our refund policy?");

for await (const event of stream) {
  if (event.type === "token") process.stdout.write(event.content);
}
```

Or, when you just want the answer:

```ts
const answer = await (await experts.conversations.ask("Summarise Q3.")).text();
```

## Why not just call the API

Sending one message is three HTTP calls in a specific order, and getting it wrong fails *silently* — the model answers, the stream looks fine, and nothing is saved:

```
POST /api/v1/responses           the user's turn        {agent: false, done: true}
POST /api/v1/responses           assistant placeholder  {agent: true, done: false}  ← keep uid
POST /api/v1/conversations/chat  {response: <placeholder uid>, ...}
```

`conversations.send()` is that sequence. The rest of the SDK is the same idea applied to the parts of the API that are easy to get subtly wrong — see [Things worth knowing](#things-worth-knowing).

## Talking to an expert

```ts
const list = await experts.experts.list();

const conversation = await experts.conversations.create({
  expert: list[0].uid,
  title: "Support",
});

const stream = await experts.conversations.send(conversation.uid, "Hello");

for await (const event of stream) {
  switch (event.type) {
    case "token":     process.stdout.write(event.content); break;
    case "thinking":  /* reasoning tokens, when the model exposes them */ break;
    case "action":    /* "rag_search", "tool_call" — for a status line */ break;
    case "done":      console.log(event.usage, event.sourceDocs); break;
  }
}
```

Everything the answer was grounded in comes back on the terminal event:

```ts
const result = await stream.result_();
result.text;             // the full reply
result.sourceDocs;       // documents retrieved, with similarity scores
result.toolsUsed;        // e.g. ["web_search"]
result.usage.totalMs;    // milliseconds (the API speaks nanoseconds)
result.error;            // set when generation failed inside a 200 — always check
```

### Stopping

```ts
await stream.cancel();   // stops the model
stream.detach();         // stop reading; let it finish and persist
```

These are genuinely different. Generation is **detached** from the HTTP request server-side, so simply walking away from the stream stops the relay, not the model — it keeps generating, keeps costing you, and still writes its answer. `cancel()` is the only thing that stops it.

## A chatbox on your website

An API key is a full user identity on the install, so it must never reach a browser. Instead your server mints a short-lived session token bound to one expert, one conversation and one origin.

**Register the origin first** against your API key, in the install's admin. That registration is also what supplies CORS for this surface.

```ts
// your server — POST /api/chat/session
const session = await experts.sessions.create({
  expert: EXPERT_UID,
  origin: "https://acme.com",
});
return Response.json({ token: session.token });
```

```ts
// the browser
import { ExpertsBrowserClient } from "@klv-ai/experts/browser";

const client = new ExpertsBrowserClient({
  baseUrl: "https://experts.acme.com",
  token: await fetch("/api/chat/session").then((r) => r.json()).then((r) => r.token),
  // Sessions last 15 minutes; a reader can outlast one.
  onExpired: () => fetch("/api/chat/session").then((r) => r.json()).then((r) => r.token),
});

const stream = await client.send("Do you ship to Ireland?");
for await (const event of stream) {
  if (event.type === "token") append(event.content);
}
```

The browser entry point has no code path that accepts an `apiKey`, so shipping one to the browser is a type error rather than a leak you find later.

**The expert must be guest-visible.** A session token carries the guest role, and an expert above that floor resolves to nothing server-side — the chat then answers on the site's default model with no persona and no knowledge, silently, with a normal 200. `sessions.create()` refuses such an expert up front and tells you how to fix it. `experts.listGuestVisible()` gives you the ones that will work.

## Knowledge

```ts
const collections = await experts.knowledge.listCollections();

const doc = await experts.knowledge.upload(file, { collection: collections[0].uid });

// Uploading is asynchronous: the file is accepted, then split, embedded and
// indexed by a worker. It is NOT searchable until that finishes.
await experts.knowledge.waitForProcessing(doc.uid);

const hits = await experts.knowledge.search("refund policy");
```

## Errors

```ts
import { ExpertsRateLimitError, ExpertsLicenseError } from "@klv-ai/experts";

try {
  await experts.conversations.ask("hi");
} catch (error) {
  if (error instanceof ExpertsRateLimitError) {
    await sleep((error.retryAfter ?? 5) * 1000);
  }
  if (error instanceof ExpertsLicenseError) {
    // The INSTALL's licence has lapsed. Nothing about your request is wrong
    // and no retry will help — its administrator has to renew.
  }
}
```

429 and 5xx are retried automatically with backoff that honours `Retry-After`. A 4xx never is. Neither is a chat turn — retrying one bills twice and can produce two answers.

## Things worth knowing

These are the parts of the API that surprise people. The SDK handles each of them; they are listed so you know what it is doing on your behalf.

| | |
|---|---|
| **Send both credentials and the wrong one wins** | The gateway checks `Authorization` first and that branch is terminal. The SDK sends exactly one. |
| **A terminal chunk can be empty on purpose** | On the tool path the text already streamed. Appending terminal content renders tool-using answers twice. |
| **Durations are nanoseconds** | Ollama's units, passed straight through. Normalised to `*Ms` fields here. |
| **HTTP 200 can still be a failure** | Generation errors arrive in the terminal event, not the status code. Check `result.error`. |
| **404 can mean "forbidden"** | A conversation you may not see answers 404 so a uid probe reveals nothing. The SDK does not guess which it was. |
| **Casing is mixed by design** | Conversation rows are camelCase; message and expert rows are snake_case; knowledge responses are wrapped in an envelope. All normalised. |
| **Streaming is plain HTTP** | NDJSON over `POST`. No WebSocket is required for chat, contrary to some older notes. |

## OpenAI-compatible endpoint

If you already have code written against OpenAI, you may not need this SDK at all. An install also speaks the OpenAI chat-completions protocol, with an expert's uid as the model:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.EXPERTS_API_KEY,
  baseURL: "https://experts.acme.com/api/openai/v1",
});

await client.chat.completions.create({
  model: EXPERT_UID,
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
```

Retrieval still happens; source documents come back under a `klavi` key on the final chunk. Use this SDK when you want conversations, knowledge management or browser sessions; use the OpenAI client when you want to drop an install into tooling that already speaks that protocol.

## Requirements

Node 22 or later — the SDK uses native `fetch`, `ReadableStream` and `AbortController` and has no runtime dependencies. An install running build pack **1.0.49** or later.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go to [SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

MIT — see [LICENSE](LICENSE).
