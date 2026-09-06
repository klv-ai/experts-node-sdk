/**
 * A voice turn, through the OpenAI-compatible endpoint.
 *
 *   npm install openai
 *   EXPERTS_BASE_URL=... EXPERTS_API_KEY=... EXPERTS_EXPERT_UID=... node agent.mjs
 *
 * The only Experts-specific thing here is the base URL and the model id.
 */

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.EXPERTS_API_KEY,
  baseURL: `${process.env.EXPERTS_BASE_URL ?? "http://localhost:5003"}/api/openai/v1`,
});

const EXPERT = process.env.EXPERTS_EXPERT_UID;

/**
 * One turn of a voice conversation.
 *
 * Streams so speech synthesis can start on the first sentence rather than
 * waiting for the whole answer — which is the difference between a natural
 * pause and an awkward one.
 */
export async function respond(history, utterance, { onSentence } = {}) {
  const stream = await client.chat.completions.create({
    model: EXPERT,
    stream: true,
    messages: [...history, { role: "user", content: utterance }],
  });

  let full = "";
  let pending = "";

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (!delta) continue;
    full += delta;
    pending += delta;

    // Hand whole sentences to TTS as they complete; synthesising word by word
    // produces flat, choppy speech.
    const boundary = pending.search(/[.!?]\s/);
    if (boundary !== -1) {
      const sentence = pending.slice(0, boundary + 1).trim();
      pending = pending.slice(boundary + 2);
      onSentence?.(sentence);
    }
  }
  if (pending.trim()) onSentence?.(pending.trim());

  return full;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const history = [];
  for (const utterance of ["What do you help with?", "Can you give an example?"]) {
    console.log(`\n> ${utterance}`);
    const answer = await respond(history, utterance, {
      onSentence: (s) => console.log(`  [speak] ${s}`),
    });
    history.push({ role: "user", content: utterance },
                 { role: "assistant", content: answer });
  }
}
