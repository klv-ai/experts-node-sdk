/**
 * Ask an expert a question from the terminal.
 *
 *   EXPERTS_BASE_URL=... EXPERTS_API_KEY=... node ask.mjs "what is our refund policy?"
 */

import { ExpertsClient, ExpertsLicenseError, ExpertsRateLimitError } from "@klv-ai/experts";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error("usage: node ask.mjs <question>");
  process.exit(1);
}

const experts = new ExpertsClient({
  baseUrl: process.env.EXPERTS_BASE_URL ?? "http://localhost:5003",
  apiKey: process.env.EXPERTS_API_KEY,
});

try {
  const stream = await experts.conversations.ask(question, {
    expert: process.env.EXPERTS_EXPERT_UID,
  });

  // Ctrl-C should STOP the model, not just close the pipe. Generation is
  // detached server-side: walking away leaves it running and billing.
  process.on("SIGINT", () => {
    stream.cancel().finally(() => process.exit(130));
  });

  for await (const event of stream) {
    if (event.type === "token") process.stdout.write(event.content);
  }

  const result = await stream.result_();
  process.stdout.write("\n");

  if (result.error) console.error(`\nGeneration failed: ${result.error}`);
  if (result.sourceDocs.length) {
    console.error("\nSources:");
    for (const doc of result.sourceDocs) {
      console.error(`  ${doc.title || doc.name}  (${doc.similarity?.toFixed(2) ?? "?"})`);
    }
  }
  console.error(`\n${result.usage.totalTokens} tokens, ${result.usage.totalMs ?? "?"}ms`);
} catch (error) {
  if (error instanceof ExpertsRateLimitError) {
    console.error(`Rate limited. Retry after ${error.retryAfter ?? "a moment"}s.`);
  } else if (error instanceof ExpertsLicenseError) {
    console.error("This install's licence has expired. Contact its administrator.");
  } else {
    console.error(error.message);
  }
  process.exit(1);
}
