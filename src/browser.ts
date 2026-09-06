/**
 * @klv-ai/experts/browser — the browser half.
 *
 * Session tokens only. Nothing exported from here can accept an API key.
 */

export {
  ExpertsBrowserClient,
  type ExpertsBrowserClientOptions,
} from "./browser-client.js";
export { ChatStream } from "./stream.js";

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

export type {
  ChatEvent,
  ChatResult,
  ConversationWithMessages,
  Message,
  SendOptions,
  SourceDocument,
  Usage,
} from "./types.js";
