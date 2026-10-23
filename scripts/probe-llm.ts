/**
 * Slice 3 provider probe (devpost/checklist.md > slice 3):
 * prove gemini-3.8-flash on Google AI answers inside the JSON envelope, and
 * record the latency / free-tier rate-limit situation for the demo.
 * Run: npm run probe
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerWithEnvelope, modelId, apiKey, DEFAULT_BASE_URL, EnvelopeParseError } from "../src/lib/llm";

function loadEnvLocal(): void {
  try {
    const lines = readFileSync(join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // no .env.local — the environment may already carry the key
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!apiKey()) {
    console.error("FAIL: GOOGLE_API_KEY is not set. Create a key at https://aistudio.google.com and put it in .env.local (see .env.example).");
    process.exit(1);
  }

  const system = `You are a personal thinking companion: original, direct, no flattery, no unwarranted critique. Think with the user, not for them.`;
  const userMessage = `I keep juggling several AI chatbots because each one lacks something I look for. If you could change one thing about how chatbots handle memory, what would it be — and what would break first if you got it wrong?`;

  console.log(`model:    ${modelId()}`);
  console.log(`endpoint: ${process.env.GEMINI_BASE_URL ?? DEFAULT_BASE_URL}`);
  console.log("calling Google AI (Gemini)…");
  try {
    const { envelope, meta } = await answerWithEnvelope({
      system,
      history: [],
      userMessage,
    });
    console.log("\n— parsed envelope —");
    console.log(`latency:     ${meta.latencyMs} ms`);
    console.log(`memory_used: ${envelope.memory_used}`);
    console.log(`sources:     ${JSON.stringify(envelope.sources)}`);
    console.log(`answer:\n${envelope.answer}`);
    if (meta.usage) {
      console.log(
        `\ntokens: ${meta.usage.prompt_tokens} in / ${meta.usage.completion_tokens} out / ${meta.usage.total_tokens} total`,
      );
    }
    const rateKeys = Object.keys(meta.rateLimit);
    if (rateKeys.length > 0) {
      console.log("rate-limit headers:");
      for (const [k, v] of Object.entries(meta.rateLimit)) console.log(`  ${k}: ${v}`);
    } else {
      console.log("rate-limit headers: none returned");
    }
    console.log("\nPASS: Gemini returned a valid JSON envelope.");
  } catch (error) {
    if (error instanceof EnvelopeParseError) {
      console.error(
        `\nFAIL: reply was not a valid JSON envelope. Raw reply:\n${error.raw.slice(0, 2000)}`,
      );
    } else {
      const status = (error as { status?: number }).status;
      console.error(
        `\nFAIL: model call did not succeed.${status ? ` HTTP status: ${status}.` : ""}`,
      );
      console.error(error instanceof Error ? error.message : error);
      if (status === 401 || status === 403)
        console.error("Check GOOGLE_API_KEY in .env.local (create one at https://aistudio.google.com).");
      if (status === 404)
        console.error(
          `Model "${modelId()}" may not exist for this key — try GEMINI_MODEL with the id shown in AI Studio (e.g. gemini-3.8-flash).`,
        );
      if (status === 429)
        console.error("Free-tier rate limit (RPM/RPD) hit — wait a minute or check the limits page; record this for the demo.");
    }
    process.exit(1);
  }
}

void main();