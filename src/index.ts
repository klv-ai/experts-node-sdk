/**
 * @klv-ai/experts — the Klavi Experts API for Node.
 *
 * This entry point is for servers. It holds an API key, which is a full user
 * identity on the install. For a browser, mint a session token here and use
 * `@klv-ai/experts/browser`.
 */

export { ExpertsClient, type ExpertsClientOptions } from "./client.js";
export { Transport, type TransportOptions, type RequestOptions } from "./http.js";
export { ChatStream, readNdjson, toEvent } from "./stream.js";

export { Conversations } from "./resources/conversations.js";
export type {
  CreateConversationOptions,
  ListConversationOptions,
  ForkOptions,
} from "./resources/conversations.js";
export { Experts } from "./resources/experts.js";
export { Knowledge } from "./resources/knowledge.js";
export { Sessions, type CreateSessionOptions } from "./resources/sessions.js";

export {
  ExpertsError,
  ExpertsAuthError,
  ExpertsPermissionError,
  ExpertsLicenseError,
  ExpertsNotFoundError,
  ExpertsRateLimitError,
  ExpertsServerError,
  ExpertsBadRequestError,
  ExpertsStreamError,
  ExpertsAbortError,
} from "./errors.js";

export type * from "./types.js";
