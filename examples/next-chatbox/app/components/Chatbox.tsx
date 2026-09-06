"use client";

/**
 * The widget.
 *
 * Never sees an API key — only a session token from our own route, which it
 * re-fetches when the old one lapses.
 */

import { useEffect, useRef, useState } from "react";
import { ExpertsBrowserClient } from "@klv-ai/experts/browser";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

export function Chatbox() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const client = useRef<ExpertsBrowserClient | null>(null);
  const conversation = useRef<string | undefined>(undefined);

  async function mint(): Promise<string> {
    const response = await fetch("/api/chat/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Keep the same conversation across refreshes so the transcript holds.
      body: JSON.stringify({ conversation: conversation.current, page: location.pathname }),
    });
    if (!response.ok) throw new Error("Chat is unavailable");
    const session = await response.json();
    conversation.current = session.conversation;
    return session.token;
  }

  useEffect(() => {
    let cancelled = false;
    mint().then((token) => {
      if (cancelled) return;
      client.current = new ExpertsBrowserClient({
        baseUrl: process.env.NEXT_PUBLIC_EXPERTS_URL!,
        token,
        // A session lasts 15 minutes and a reader can outlast one. Without
        // this the chat dies mid-conversation with a 401.
        onExpired: mint,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send() {
    const question = input.trim();
    if (!question || busy || !client.current) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: question }, { role: "assistant", text: "" }]);

    try {
      const stream = await client.current.send(question);
      for await (const event of stream) {
        if (event.type === "token") {
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1]!;
            next[next.length - 1] = { ...last, text: last.text + event.content };
            return next;
          });
        }
        // A 200 is not proof of an answer: generation reports its own
        // failures in the terminal event.
        if (event.type === "done" && event.error) {
          setTurns((t) => {
            const next = [...t];
            next[next.length - 1] = {
              role: "assistant",
              text: "Sorry — I couldn't answer that just now.",
            };
            return next;
          });
        }
      }
    } catch {
      setTurns((t) => [...t.slice(0, -1), { role: "assistant", text: "Sorry — something went wrong." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chatbox">
      <div className="chatbox__log">
        {turns.map((turn, i) => (
          <p key={i} className={`chatbox__turn chatbox__turn--${turn.role}`}>
            {turn.text || (busy && i === turns.length - 1 ? "…" : "")}
          </p>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
