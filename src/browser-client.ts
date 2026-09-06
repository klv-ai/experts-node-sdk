/**
 * The browser client.
 *
 * Takes a session token and nothing else. There is deliberately no code path
 * here that accepts an API key, so shipping one to a browser is a type error
 * rather than a leak you discover later.
 *
 * What a session token can do is fixed when your server mints it: one expert,
 * one conversation, one origin, a few minutes. Everything else is refused by
 * the gateway, so this client exposes only the operations that will work.
 */

import { Transport } from "./http.js";
import { Conversations } from "./resources/conversations.js";
import type { ChatStream } from "./stream.js";
import type { ConversationWithMessages, SendOptions } from "./types.js";

export interface ExpertsBrowserClientOptions {
  /** The install's gateway. Must match the origin the token was minted for. */
  baseUrl: string;
  /** From your server's `sessions.create()`. Expires; see `onExpired`. */
  token: string;
  /**
   * Called when the token is rejected as expired or revoked.
   *
   * Return a fresh token from your own backend to keep the chat alive, or
   * nothing to let the error surface.
   */
  onExpired?: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof globalThis.fetch;
}

export class ExpertsBrowserClient {
  /** The conversation this session is bound to. Fixed at mint time. */
  readonly conversationUid: string;

  private transport: Transport;
  private conversations: Conversations;
  private readonly options: ExpertsBrowserClientOptions;

  constructor(options: ExpertsBrowserClientOptions) {
    if (!options.token) throw new Error("A session token is required");
    if (options.token.startsWith("sk-")) {
      throw new Error(
        "That is an API key, not a session token. An API key is a full user " +
          "identity and must never reach a browser — mint a session token on " +
          "your server with sessions.create() and pass that instead.",
      );
    }
    this.options = options;
    this.transport = this.build(options.token);
    this.conversations = new Conversations(this.transport);
    this.conversationUid = readClaim(options.token, "conv") ?? "";
  }

  private build(token: string): Transport {
    return new Transport({
      baseUrl: this.options.baseUrl,
      token,
      fetch: this.options.fetch,
    });
  }

  /** Swap in a fresh token without losing the conversation. */
  setToken(token: string): void {
    this.transport = this.build(token);
    this.conversations = new Conversations(this.transport);
  }

  /** Send a message in the bound conversation and stream the reply. */
  async send(question: string, options: SendOptions = {}): Promise<ChatStream> {
    return this.withRefresh(() =>
      this.conversations.send(this.conversationUid, question, options),
    );
  }

  /** The transcript so far — for restoring a widget after a reload. */
  async history(): Promise<ConversationWithMessages> {
    return this.withRefresh(() => this.conversations.get(this.conversationUid));
  }

  /**
   * Retry once with a fresh token when the session has lapsed.
   *
   * A session lives 15 minutes; a visitor reading a long answer can outlast
   * it. Without this the chat simply dies mid-conversation with a 401.
   */
  private async withRefresh<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 401 || !this.options.onExpired) throw error;
      const fresh = await this.options.onExpired();
      if (!fresh) throw error;
      this.setToken(fresh);
      return run();
    }
  }
}

/** Read one claim from a JWT payload. No verification — the server does that. */
function readClaim(token: string, claim: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const value = (JSON.parse(json) as Record<string, unknown>)[claim];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
