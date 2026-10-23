import OpenAI from "openai";

/**
 * The only module in the app that talks to Google AI — Gemini via the
 * OpenAI-compatible endpoint (spec.md > Stack).
 * Every model call in the product goes through here, so a provider or
 * model swap stays a one-file change.
 */

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
/**
 * gemini-3.8-flash is a fast Flash model; 60s leaves headroom for its
 * thinking pass plus a long envelope (Google counts thinking tokens against
 * max_output_tokens). Re-baselined from the GLM-era 180s after the swap —
 * evidence recorded in devpost/checklist.md (slice 3).
 */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Room for Gemini's thinking pass AND the JSON envelope answer. */
export const MAX_COMPLETION_TOKENS = 2048;

/** Google AI Studio key; GEMINI_API_KEY accepted as the common alias. */
export function apiKey(): string {
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
}

/** The model id, read at call time so env overrides (.env.local) always win. */
export function modelId(): string {
  return process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type EnvelopeSource = {
  session_id: number;
  date: string;
  taken: string;
  why_now: string;
};

/** The structured reply every answer call must return (spec.md > External Services). */
export type Envelope = {
  answer: string;
  memory_used: boolean;
  sources: EnvelopeSource[];
  /** Present only while onboarding is active (spec.md > Onboarding conversation). */
  onboarding_complete?: boolean;
};

export const ENVELOPE_CONTRACT = `Reply with ONLY a JSON object — no markdown fences, no text before or after it — with exactly this shape:
{"answer": "your reply in markdown", "memory_used": false, "sources": []}
- "answer": your full reply, written in markdown.
- "memory_used": true only if this reply draws on memories from earlier sessions that were injected into this conversation; otherwise false.
- "sources": when memory_used is true, one object per memory you actually used: {"session_id": <number>, "date": "<YYYY-MM-DD>", "taken": "<what you took from it>", "why_now": "<why it matters to this message>"}. When memory_used is false, sources must be [].`;

const REPAIR_INSTRUCTION = `Your previous reply was not a single valid JSON object. Answer again with ONLY the JSON object in the required shape — no markdown fences, no extra text.`;

export class EnvelopeParseError extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super("Model reply was not a valid JSON envelope");
    this.name = "EnvelopeParseError";
    this.raw = raw;
  }
}

let _client: OpenAI | null = null;

/**
 * Lazily constructed so environment variables set at runtime (scripts
 * loading .env.local, Next loading env) are always picked up.
 */
export function getClient(): OpenAI {
  _client ??= new OpenAI({
    apiKey: apiKey(),
    baseURL: process.env.GEMINI_BASE_URL ?? DEFAULT_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return _client;
}

export type RawCall = {
  raw: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  rateLimit: Record<string, string>;
  latencyMs: number;
};

function grabRateLimit(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.includes("ratelimit") || k.includes("rate-limit")) out[key] = value;
  });
  return out;
}

/** One raw chat-completion call. No other file may call the model directly. */
export async function callModel(messages: ChatMessage[]): Promise<RawCall> {
  const started = Date.now();
  const { data, response } = await getClient().chat.completions
    .create({
      model: modelId(),
      messages,
      temperature: 0.7,
      max_tokens: MAX_COMPLETION_TOKENS,
      // Gemini 3.x models think by default; thinking tokens count against
      // max_tokens, and an uncapped budget shows up as latency. "low" keeps
      // quality for conversational turns while capping the burn — verified
      // against the live API at probe time (devpost/checklist.md, slice 3).
      reasoning_effort: "low",
    })
    .withResponse();
  return {
    raw: data.choices[0]?.message?.content ?? "",
    usage: data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        }
      : null,
    rateLimit: grabRateLimit(response.headers),
    latencyMs: Date.now() - started,
  };
}

/** Pull the JSON object out of a reply that may carry fences or stray prose. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(raw.slice(start, end + 1));
}

function parseEnvelope(raw: string): Envelope {
  const obj = extractJsonObject(raw) as Record<string, unknown>;
  const answer = typeof obj.answer === "string" ? obj.answer : "";
  if (!answer.trim()) throw new Error("envelope missing a non-empty answer");
  const sources = Array.isArray(obj.sources)
    ? obj.sources.flatMap((s) => {
        if (typeof s !== "object" || s === null) return [];
        const r = s as Record<string, unknown>;
        return [
          {
            session_id:
              typeof r.session_id === "number"
                ? r.session_id
                : Number(r.session_id) || 0,
            date: typeof r.date === "string" ? r.date : "",
            taken: typeof r.taken === "string" ? r.taken : "",
            why_now: typeof r.why_now === "string" ? r.why_now : "",
          },
        ];
      })
    : [];
  return { answer, memory_used: obj.memory_used === true, sources, onboarding_complete: typeof obj.onboarding_complete === "boolean" ? obj.onboarding_complete : undefined };
}

/**
 * The answer call: system prompt + conversation in, envelope out.
 * One repair re-prompt on malformed JSON; after that the caller decides
 * how to degrade (spec.md > Important Failure Modes).
 */
export async function answerWithEnvelope(params: {
  system: string;
  history: ChatMessage[];
  userMessage: string;
}): Promise<{ envelope: Envelope; meta: RawCall }> {
  const base: ChatMessage[] = [
    { role: "system", content: `${params.system}\n\n${ENVELOPE_CONTRACT}` },
    ...params.history,
    { role: "user", content: params.userMessage },
  ];
  const first = await callModel(base);
  try {
    return { envelope: parseEnvelope(first.raw), meta: first };
  } catch {
    const repair = await callModel([
      ...base,
      { role: "assistant", content: first.raw },
      { role: "user", content: REPAIR_INSTRUCTION },
    ]);
    try {
      return { envelope: parseEnvelope(repair.raw), meta: repair };
    } catch {
      throw new EnvelopeParseError(repair.raw);
    }
  }
}
