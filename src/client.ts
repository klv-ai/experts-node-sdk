/**
 * The server-side client.
 *
 * Holds the `sk-` API key, which is a full user identity on the install — so
 * it belongs on a server and nowhere else. To put a chatbox on a public page,
 * use `sessions.create()` to mint a short-lived browser token and hand THAT
 * to the page; see `@klv-ai/experts/browser`.
 */

import { Transport, type TransportOptions } from "./http.js";
import { Conversations } from "./resources/conversations.js";
import { Experts } from "./resources/experts.js";
import { Knowledge } from "./resources/knowledge.js";
import { Sessions } from "./resources/sessions.js";

export interface ExpertsClientOptions extends Omit<TransportOptions, "token"> {
  /** Your `sk-` key. Server-side only. */
  apiKey: string;
  /** The install's gateway, e.g. https://experts.acme.com */
  baseUrl: string;
}

export class ExpertsClient {
  readonly conversations: Conversations;
  readonly experts: Experts;
  readonly knowledge: Knowledge;
  readonly sessions: Sessions;
  /** Escape hatch for endpoints this SDK does not wrap yet. */
  readonly transport: Transport;

  constructor(options: ExpertsClientOptions) {
    if (!options.apiKey) throw new Error("apiKey is required");
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      // Not a hypothetical: `Authorization: Bearer sk-...` now works, which
      // makes putting the key in front-end code a one-line change. The server
      // also withholds CORS headers from key-authenticated requests so this
      // fails loudly in development rather than shipping.
      throw new Error(
        "ExpertsClient holds an API key and must not run in a browser. Mint a " +
          "session token on your server with sessions.create(), then use " +
          "ExpertsBrowserClient from '@klv-ai/experts/browser'.",
      );
    }
    this.transport = new Transport(options);
    this.conversations = new Conversations(this.transport);
    this.experts = new Experts(this.transport);
    this.knowledge = new Knowledge(this.transport);
    this.sessions = new Sessions(this.transport);
  }
}
