/**
 * Slice 1 risk probe (devpost/checklist.md > slice 1):
 * prove NVIDIA NIM answers inside the JSON envelope, and record the
 * latency / rate-limit situation for the demo.
 * Run: npm run probe
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerWithEnvelope, modelId, EnvelopeParseError } from "../src/lib/llm";

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
  if (!process.env.NVIDIA_API_KEY) {
    console.error("FAIL: NVIDIA_API_KEY is not set. Put it in .env.local (see .env.example).");
    process.exit(1);
  }

  const system = `You are a personal thinking companion: original, direct, no flattery, no unwarranted critique. Think with the user, not for them.`;
  const userMessage = `I keep juggling several AI chatbots because each one lacks something I look for. If you could change one thing about how chatbots handle memory, what would it be — and what would break first if you got it wrong?`;

  console.log(`model: ${modelId()}`);
  console.log("calling NVIDIA NIM…");
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
    console.log("\nPASS: NIM returned a valid JSON envelope.");
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
      if (status === 401) console.error("Check NVIDIA_API_KEY in .env.local.");
      if (status === 404)
        console.error(
          `Model "${modelId()}" may not exist for this key — try the id shown on build.nvidia.com (e.g. z-ai/glm-5-3-flash).`,
        );
      if (status === 429) console.error("Rate limit or credits exhausted — record this for the demo.");
    }
    process.exit(1);
  }
}

void main();
