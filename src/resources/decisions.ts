/**
 * A decision model's answers (Experts 1.2, `POST /api/v1/llm/decide`).
 *
 * A decision model is a small model that answers named questions about a case
 * in a fraction of a second: one of a few choices, a yes/no as a probability,
 * or a score. It never writes text. The install's own decision model answers
 * unless you name a model (and, optionally, the Ollama backend it is on).
 *
 * Each question is `{type, instructions, criteria}`:
 * - `choice`: `criteria` names 2 to 16 options, `{option: what it means}`,
 *   lower-case names. The answer's `choice` is the pick.
 * - `noul`: no criteria; the answer's `noul` is the probability of yes.
 *   Measure your own threshold: on small models it seldom reaches 0.5.
 * - `score`: `criteria` is a list of descriptions.
 *
 * Put the case alone in `state`, and facts about it in the options'
 * descriptions: with facts in the state, small models pick the same option
 * for nearly everything. Usage is counted under `feature` (default `decide`).
 */

import type { Transport } from "../http.js";
import type { Decision, DecisionAnswer } from "../types.js";

export interface DecisionQuestion {
  type: "choice" | "noul" | "score";
  instructions?: string;
  criteria?: Record<string, string> | string[];
}

export interface DecideOptions {
  /** A decision model on the install; its own decision model when left out. */
  model?: string;
  /** The Ollama backend's uid the model is on; the install's default when left out. */
  backend?: string;
  /** What the usage is counted under (default `decide`). */
  feature?: string;
  /** Your own reference, kept with the usage. */
  referenceId?: string;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function floats(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Raw)) if (typeof x === "number") out[k] = x;
  return out;
}

export function toAnswer(raw: unknown): DecisionAnswer {
  const r = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const choice = typeof r.choice === "string" ? r.choice : null;
  const probabilities = floats(r.probabilities);
  const legend: Record<string, string> = {};
  if (r.legend && typeof r.legend === "object") {
    for (const [k, v] of Object.entries(r.legend as Raw)) legend[k] = String(v);
  }
  return {
    type: typeof r.type === "string" ? r.type : "",
    choice,
    probability: choice !== null ? (probabilities[choice] ?? null) : null,
    probabilities,
    confidence: num(r.confidence),
    noul: num(r.noul),
    score: num(r.score),
    legend,
  };
}

export function toDecision(raw: unknown): Decision {
  const r = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const answers: Record<string, DecisionAnswer> = {};
  if (r.answers && typeof r.answers === "object") {
    for (const [name, a] of Object.entries(r.answers as Raw)) answers[name] = toAnswer(a);
  }
  const usage = (r.usage && typeof r.usage === "object" ? r.usage : {}) as Raw;
  return {
    model: typeof r.model === "string" ? r.model : "",
    answers,
    backend: typeof r.backend === "string" && r.backend ? r.backend : null,
    usage: { inputTokens: num(usage.input_tokens) ?? 0, outputTokens: num(usage.output_tokens) ?? 0 },
  };
}

export async function decide(
  transport: Transport,
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, DecisionQuestion>,
  options: DecideOptions = {},
): Promise<Decision> {
  const body: Raw = { state, questions };
  if (options.model !== undefined) body.model = options.model;
  if (options.backend !== undefined) body.backend = options.backend;
  if (options.feature !== undefined) body.feature = options.feature;
  if (options.referenceId !== undefined) body.reference_id = options.referenceId;
  // A decision changes nothing, so a 5xx (the model still downloading) is
  // tried again like any read
  return toDecision(await transport.request({ method: "POST", path: "/api/v1/llm/decide", body }));
}
