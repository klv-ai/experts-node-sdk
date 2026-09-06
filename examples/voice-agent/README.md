# Voice agent

The case that prompted this SDK: a live voice/video session that needs an LLM
turn per utterance, from a pipeline that already speaks OpenAI.

The answer is that you do not need this SDK at all here. An install speaks the
OpenAI chat-completions protocol, so point the stock client at it and set
`model` to the expert's uid. Retrieval still happens — the expert's knowledge
is in the answer — and the pipeline never learns that any of that exists.

```
base_url = https://<install>/api/openai/v1
api_key  = sk-...
model    = <expert uid>
```

`agent.mjs` is a minimal loop. Drop the same three values into LiveKit Agents,
Pipecat, Vapi or anything else that takes an OpenAI-compatible base URL.

## Why not the native API

You could, and `../express-proxy` shows how. Use the compatible endpoint when
something else already owns the conversation loop; use the native SDK when you
want conversations, knowledge management or browser sessions.

## What differs from OpenAI

- One choice per response — `n > 1` is refused rather than silently ignored.
- `response_format` and caller-supplied `tools` are refused: an expert's output
  shape and tools are configured on the expert.
- Retrieval metadata rides on the final chunk under a `klavi` key. Ignore it and
  the response is ordinary OpenAI.
- A conversation carries **memory of the API key's owner**. Ask "what's my
  name?" and you may get the key holder's, not your caller's. It is not
  stateless in the way OpenAI is.
