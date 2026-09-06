# Examples

Each is self-contained and runnable against a development install.

| | What it shows |
|---|---|
| [`express-proxy`](./express-proxy) | The minimum safe pattern: the key stays on the server, the browser talks to your route |
| [`next-chatbox`](./next-chatbox) | A chatbox on a public page, using browser session tokens |
| [`voice-agent`](./voice-agent) | The OpenAI-compatible endpoint driving a voice pipeline |
| [`cli`](./cli) | One-shot questions from a terminal |

All of them read `EXPERTS_BASE_URL` and `EXPERTS_API_KEY` from the environment.
None of them commit a key.
