/** Experts — the personas a conversation can be attached to. */

import type { Transport } from "../http.js";
import { ExpertsNotFoundError } from "../errors.js";
import type { Expert, UUID } from "../types.js";

interface RawExpert {
  uid: string;
  name?: string;
  description?: string | null;
  // `modelfile` in the database, `model_file` on the wire. Neither name says
  // what it is, which is the expert's system prompt.
  model_file?: string | null;
  model?: string | null;
  avatar?: string | null;
  starters?: string[];
  collections?: string[];
  temperature?: number | null;
  voice?: string | null;
  output_language?: string | null;
  min_role_id?: number;
  private?: boolean;
}

// Expert rows come back snake_case, unlike conversation rows. Normalised here.
function toExpert(raw: RawExpert): Expert {
  return {
    uid: raw.uid,
    name: raw.name ?? "",
    description: raw.description ?? null,
    instructions: raw.model_file ?? null,
    model: raw.model ?? null,
    avatar: raw.avatar ?? null,
    starters: raw.starters ?? [],
    collections: raw.collections ?? [],
    temperature: raw.temperature ?? null,
    voice: raw.voice ?? null,
    outputLanguage: raw.output_language ?? null,
    minRoleId: raw.min_role_id ?? 2,
    private: raw.private ?? false,
  };
}

export class Experts {
  constructor(private readonly transport: Transport) {}

  /** Every expert this credential may use. */
  async list(): Promise<Expert[]> {
    const raw = await this.transport.request<RawExpert[]>({
      path: "/api/v1/profiles/",
    });
    return (raw ?? []).map(toExpert);
  }

  async get(uid: UUID): Promise<Expert> {
    const found = (await this.list()).find((expert) => expert.uid === uid);
    if (!found) throw new ExpertsNotFoundError(`Expert ${uid} not found`, { status: 404 });
    return found;
  }

  /**
   * Experts a browser session may use.
   *
   * A session token carries the guest role, and an expert above that floor
   * resolves to nothing server-side — the chat then answers on the site
   * default model with no persona and no knowledge, silently. Use this to
   * build a picker that only offers experts that will actually work.
   */
  async listGuestVisible(): Promise<Expert[]> {
    return (await this.list()).filter((e) => !e.private && e.minRoleId <= 1);
  }
}
