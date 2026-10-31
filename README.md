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
    case "queued":    /* waiting in line for another mesh server's model */ break;
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
result.model;            // the model that answered
result.dataArtifacts;    // tables, charts and sheet edits a tool produced
```

On an [Experts Mesh](https://klv.ai/mesh), an answer can come from another server's model. `result.servedBy` names that server; `result.meshFallback` says when the expert's own model was out of reach and this server's answered instead. While a busy server's model has the request in line, the stream sends `queued` events (`event.ahead`, `event.name`) and nothing else.

### Stopping

```ts
await stream.cancel();   // stops the model; true if the server found it running
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

**The expert must be guest-visible**: minimum role Guest, not private, and not limited to org profiles. A session token carries the guest role, so `sessions.create()` refuses any other expert up front and tells you how to fix it. `experts.listGuestVisible()` gives you the ones that will work.

**On an Experts Mesh, the browser talks to the server you minted on.** A session lives on the server that issued it; another member of the mesh does not know it and answers 401, so give the browser client that server's `baseUrl`.

## Knowledge

```ts
const collections = await experts.knowledge.listCollections();

const job = await experts.knowledge.upload(file, { collection: collections[0].uid });

// Uploading is asynchronous: the file is accepted into an indexing job, then
// split, embedded and indexed by a worker. It is NOT searchable until that
// finishes — and the job is where the document's uid and any failure appear.
const status = await experts.knowledge.waitForProcessing(job);
if (!status.ready) console.log(status.failed); // e.g. a password-protected PDF, and why

for (const hit of await experts.knowledge.search("refund policy", { collections: [collections[0].uid] })) {
  console.log(hit.documentName, hit.similarity, hit.text);
}
```

`search()` returns passages, closest first, each with the document it came from. `listDocuments({ collection, search })` lists and filters documents by name, title or summary; `deleteDocument(uid)` removes one. Allow longer than the two-minute default for large files, and much longer for recordings, which are transcribed before they become documents.

## Errors

```ts
import {
  ExpertNotAvailableError,
  ExpertsLicenseError,
  ExpertsRateLimitError,
} from "@klv-ai/experts";

try {
  await experts.conversations.ask("hi", { expert: EXPERT_UID });
} catch (error) {
  if (error instanceof ExpertsRateLimitError) {
    await sleep((error.retryAfter ?? 5) * 1000);
  }
  if (error instanceof ExpertNotAvailableError) {
    // This key's user may not use that expert (its role, privacy or org
    // profiles). Pick another from experts.experts.list().
  }
  if (error instanceof ExpertsLicenseError) {
    // The INSTALL's licence is not valid. Nothing about your request is wrong
    // and no retry will help — its administrator has to act. error.readOnly
    // is true for a recently expired licence: reads work, writes do not.
  }
}
```

For 30 days after its licence expires, an install is read-only: anything sent as a GET still works, and everything else throws `ExpertsLicenseReadOnlyError` (an `ExpertsLicenseError`). That includes sending a message and `knowledge.search()`, which read but go out as a POST.

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
| **A refused turn leaves a placeholder behind** | `/chat` updates a message row you created first. When it refuses to start, nothing settles that row, and the conversation shows the reply "typing" forever. The SDK settles it with the reason. |
| **An expert's instructions are for its managers** | Since 1.1, `Expert.instructions` is only filled in for the expert's owner and administrators. |
| **Knowledge says "forbidden" as 401** | The knowledge service answers a document you may not read with 401. The SDK throws `ExpertsPermissionError`, not `ExpertsAuthError`: the key is fine. |

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

Node 22 or later — the SDK uses native `fetch`, `ReadableStream` and `AbortController` and has no runtime dependencies. An install running build pack **1.0.49** or later. Tested against **1.1**; the mesh fields and the read-only licence error are only sent by a 1.1 install.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go to [SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

MIT — see [LICENSE](LICENSE).
