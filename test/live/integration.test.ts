/**
 * Integration tests against a real install.
 *
 * Opt-in: `npm run test:live` with EXPERTS_TEST_KEY set. These exist to catch
 * DRIFT — the SDK hand-writes its types against Python services that can
 * change independently, so the point is to assert response *shapes* here
 * rather than at a customer.
 *
 *   EXPERTS_BASE_URL=http://localhost:5003 EXPERTS_TEST_KEY=sk-... npm run test:live
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExpertsClient } from "../../src/index.js";
import { ExpertsNotFoundError } from "../../src/errors.js";
import type { Conversation, Expert } from "../../src/types.js";

const KEY = process.env["EXPERTS_TEST_KEY"];
const BASE_URL = process.env["EXPERTS_BASE_URL"] ?? "http://localhost:5003";

const live = KEY ? describe : describe.skip;

live("against a real install", () => {
  const client = new ExpertsClient({ apiKey: KEY!, baseUrl: BASE_URL });
  const created: Conversation[] = [];
  let experts: Expert[] = [];

  beforeAll(async () => {
    experts = await client.experts.list();
  });

  afterAll(async () => {
    // Leave no litter in the owner's sidebar.
    await Promise.allSettled(created.map((c) => client.conversations.delete(c.uid)));
  });

  describe("experts", () => {
    it("lists experts with the shape the SDK claims", () => {
      expect(experts.length).toBeGreaterThan(0);
      const expert = experts[0]!;
      expect(expert).toMatchObject({
        uid: expect.any(String),
        name: expect.any(String),
        minRoleId: expect.any(Number),
        private: expect.any(Boolean),
      });
      expect(Array.isArray(expert.starters)).toBe(true);
    });

    it("reports guest visibility, which browser sessions depend on", () => {
      const guests = experts.filter((e) => !e.private && e.minRoleId <= 1);
      for (const expert of guests) expect(expert.minRoleId).toBeLessThanOrEqual(1);
    });
  });

  describe("conversations", () => {
    it("creates, reads back and lists", async () => {
      const conversation = await client.conversations.create({
        title: "SDK live test",
        hidden: true,
      });
      created.push(conversation);

      expect(conversation.uid).toEqual(expect.any(String));

      const fetched = await client.conversations.get(conversation.uid);
      expect(fetched.uid).toBe(conversation.uid);
      expect(Array.isArray(fetched.messages)).toBe(true);
    });

    it("404s a conversation that does not exist", async () => {
      await expect(
        client.conversations.get("00000000-0000-0000-0000-000000000000"),
      ).rejects.toBeInstanceOf(ExpertsNotFoundError);
    });
  });

  describe("sending a message", () => {
    it("streams a reply and persists it", async () => {
      // An expert is pinned to a model, and that model can be broken
      // independently of anything this SDK does — a hosted model the provider
      // retired, a tag nobody pulled. Generation then fails INSIDE a 200
      // response, reporting itself only in the terminal event's `error`.
      //
      // So: use EXPERTS_TEST_EXPERT when the operator names one, otherwise
      // try candidates until one generates, and fail with the collected
      // reasons if none can. "No expert on this install can answer" is a real
      // result worth reporting clearly; "expected [keepalive, done] to include
      // token" is not.
      const pinned = process.env["EXPERTS_TEST_EXPERT"];
      const candidates = pinned
        ? experts.filter((e) => e.uid === pinned)
        : experts.filter((e) => !e.private);
      expect(candidates.length, "no usable expert on this install").toBeGreaterThan(0);

      const failures: string[] = [];
      for (const expert of candidates.slice(0, 4)) {
        const conversation = await client.conversations.create({
          title: "SDK live send",
          expert: expert.uid,
          hidden: true,
        });
        created.push(conversation);

        const stream = await client.conversations.send(
          conversation.uid,
          "Reply with exactly: pong",
          { expert: expert.uid },
        );
        const seen: string[] = [];
        for await (const event of stream) seen.push(event.type);
        const result = await stream.result_();

        if (result.error) {
          failures.push(`${expert.name}: ${result.error}`);
          continue;
        }

        expect(seen).toContain("token");
        expect(seen.at(-1)).toBe("done");

        // The whole point of the three-call sequence: it persists. A caller
        // who skipped the placeholder rows would see an empty conversation.
        const reloaded = await client.conversations.get(conversation.uid);
        expect(reloaded.messages.length).toBeGreaterThanOrEqual(2);
        expect(reloaded.messages.find((m) => m.agent && m.text)?.text).toBeTruthy();
        return;
      }

      throw new Error(
        `No expert on this install could generate an answer:\n  ${failures.join("\n  ")}`,
      );
    });

    it("reports usage in milliseconds, not nanoseconds", async () => {
      const conversation = await client.conversations.create({
        title: "SDK live usage",
        hidden: true,
      });
      created.push(conversation);

      const result = await (
        await client.conversations.send(conversation.uid, "Say: ok")
      ).result_();

      expect(result.usage.totalTokens).toBeGreaterThan(0);
      if (result.usage.totalMs !== undefined) {
        // A nanosecond value would be ~1e9 for a one-second call.
        expect(result.usage.totalMs).toBeLessThan(600_000);
      }
    });
  });

  describe("knowledge", () => {
    it("unwraps the envelope the embedding service uses", async () => {
      const collections = await client.knowledge.listCollections();
      expect(Array.isArray(collections)).toBe(true);
      if (collections.length) {
        expect(collections[0]).toMatchObject({
          uid: expect.any(String),
          name: expect.any(String),
          fileCount: expect.any(Number),
        });
      }
    });
  });

  describe("browser sessions", () => {
    it("mints a token bound to one expert and conversation", async () => {
      const guest = experts.find((e) => !e.private && e.minRoleId <= 1);
      if (!guest) return; // no guest-visible expert on this install

      const origin = process.env["EXPERTS_TEST_ORIGIN"];
      if (!origin) return; // origin must be registered against the key first

      const session = await client.sessions.create({ expert: guest.uid, origin });
      expect(session.token).toEqual(expect.any(String));
      expect(session.token.startsWith("sk-")).toBe(false);
      expect(session.expiresIn).toBeLessThanOrEqual(900);

      await client.sessions.revoke(session.sessionId);
    });
  });
});
