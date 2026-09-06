/**
 * The minimum safe pattern.
 *
 * The API key lives on the server. The browser calls YOUR route, and you
 * stream the answer through. Nothing about the install is exposed, and there
 * is no session token to manage.
 *
 * Use this when your users are already authenticated by your own app. If the
 * page is public and you would rather the browser talk to the install
 * directly, see ../next-chatbox.
 *
 *   node --env-file=../../.env server.mjs
 */

import { createServer } from "node:http";
import { ExpertsClient } from "@klv-ai/experts";

const experts = new ExpertsClient({
  baseUrl: process.env.EXPERTS_BASE_URL,
  apiKey: process.env.EXPERTS_API_KEY,
});

const EXPERT = process.env.EXPERTS_EXPERT_UID;

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/chat") {
    res.writeHead(404).end();
    return;
  }

  const body = await new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(JSON.parse(raw || "{}")));
  });

  // Authenticate YOUR user here before spending inference on them.
  // if (!(await yourSession(req))) return res.writeHead(401).end();

  try {
    const conversation =
      body.conversation ??
      (await experts.conversations.create({ expert: EXPERT })).uid;

    const stream = await experts.conversations.send(conversation, body.message, {
      expert: EXPERT,
    });

    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      // Tell the browser (and any proxy) not to buffer, or the whole point of
      // streaming is lost to a 4KB buffer somewhere in the middle.
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-conversation": conversation,
    });

    for await (const event of stream) {
      if (event.type === "token") res.write(event.content);
      // Generation can fail INSIDE a 200. Without this the user sees an
      // answer that simply stops, with no reason given.
      if (event.type === "done" && event.error) res.write(`\n\n[error: ${event.error}]`);
    }
    res.end();
  } catch (error) {
    // Headers may already be sent, in which case the status is long gone.
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(3000, () => console.log("http://localhost:3000"));
