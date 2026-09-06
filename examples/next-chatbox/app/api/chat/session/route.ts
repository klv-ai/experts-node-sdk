/**
 * Mint a browser session token.
 *
 * The only file in this example that touches the API key. Everything the
 * visitor's browser can do is decided here, at mint time: one expert, one
 * conversation, one origin, fifteen minutes.
 */

import { ExpertsClient } from "@klv-ai/experts";

const experts = new ExpertsClient({
  baseUrl: process.env.EXPERTS_BASE_URL!,
  apiKey: process.env.EXPERTS_API_KEY!,
});

export async function POST(request: Request) {
  // Rate limit by IP here if the page is genuinely public — minting is cheap,
  // but every token is a licence to spend inference.
  const body = await request.json().catch(() => ({}));

  try {
    const session = await experts.sessions.create({
      expert: process.env.EXPERTS_EXPERT_UID!,
      origin: process.env.NEXT_PUBLIC_SITE_ORIGIN!,
      // Passing the previous conversation back keeps a visitor's transcript
      // across a token refresh or a page reload.
      conversation: body.conversation,
      metadata: { page: body.page },
    });

    // Deliberately NOT returning session.sessionId: it is the revocation
    // handle, and the browser has no use for it.
    return Response.json({
      token: session.token,
      conversation: session.conversation,
      expert: session.expert,
      expiresIn: session.expiresIn,
    });
  } catch (error) {
    console.error("Could not mint a chat session", error);
    return Response.json({ error: "Chat is unavailable right now" }, { status: 503 });
  }
}
