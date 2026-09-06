/**
 * Browser session tokens.
 *
 * The bridge between a server that holds the API key and a browser that must
 * never see one. Your backend calls `create()`, hands the returned token to a
 * visitor, and that token can talk to exactly one expert in one conversation
 * for a few minutes from one origin.
 *
 * The origin has to be registered against the key first, by an administrator.
 * That registration is also what supplies CORS for the surface, so a customer
 * site is never at the mercy of the install's operator-level allow-list.
 */

import type { Transport } from "../http.js";
import type { BrowserSession, UUID } from "../types.js";

export interface CreateSessionOptions {
  /** Must be guest-visible, or the call is refused with an explanation. */
  expert: UUID;
  /** Exactly as the browser will send it: scheme + host + port, no path. */
  origin: string;
  /** Resume an existing conversation so a page reload keeps the transcript. */
  conversation?: UUID;
  /** Seconds. Clamped by the server to a maximum of 900. */
  ttl?: number;
  /** Opaque; recorded with the session for your own analytics attribution. */
  metadata?: Record<string, unknown>;
}

interface RawSession {
  token: string;
  session_id: string;
  expires_in: number;
  conversation: string;
  expert: { uid: string; name: string; avatar: string | null; description: string | null };
}

export class Sessions {
  constructor(private readonly transport: Transport) {}

  /** Mint a token to hand to one browser. */
  async create(options: CreateSessionOptions): Promise<BrowserSession> {
    const raw = await this.transport.request<RawSession>({
      method: "POST",
      path: "/api/v1/public/sessions",
      body: {
        expert: options.expert,
        origin: options.origin,
        conversation: options.conversation ?? null,
        ttl: options.ttl ?? null,
        metadata: options.metadata ?? {},
      },
      idempotent: false,
    });
    return {
      token: raw.token,
      sessionId: raw.session_id,
      expiresIn: raw.expires_in,
      conversation: raw.conversation,
      expert: raw.expert,
    };
  }

  /** Kill a session immediately, before its token would expire. */
  async revoke(sessionId: string): Promise<void> {
    await this.transport.request({
      method: "DELETE",
      path: `/api/v1/public/sessions/${sessionId}`,
    });
  }
}
