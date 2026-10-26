import OpenAI from "openai";

/**
 * The only module in the app that talks to the LLM provider (NVIDIA NIM).
 * Every model call in the product goes through here, so a provider or
 * model swap stays a one-file change (spec.md > Stack).
 */

export const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
/**
 * Measured NIM latency with nvidia/nemotron-3.5-bolt-e4b is ~2-4s.
 * 180s ceiling provides ample headroom for complex reasoning turns.
 */
export const REQUEST_TIMEOUT_MS = 180_000;
/** Reduced output context ceiling per user instruction. */
export const MAX_COMPLETION_TOKENS = 2048;

/** NVIDIA NIM API key (supports NVIDIA_API_KEY or NIM_API_KEY). */
export function apiKey(): string {
  return (
    process.env.NVIDIA_API_KEY ??
    process.env.NIM_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GEMINI_API_KEY ??
    ""
  );
}

/** The model id, read at call time so env overrides (.env.local) always win. */
export function modelId(): string {
  return process.env.NIM_MODEL ?? "nvidia/nemotron-3.5-bolt-e4b";
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

export const STREAM_ENVELOPE_CONTRACT = `If you draw on any injected memories from earlier sessions, start your reply with:
<receipts memory_used="true" sources='[{"session_id": 1, "date": "2026-10-02", "taken": "<excerpt>", "why_now": "<relevance>"}]'/>
If you did not use any memories, start with:
<receipts memory_used="false" sources='[]'/>
Immediately after the <receipts .../> tag, output your full response in clean Markdown. Do NOT wrap your markdown response in JSON.`;

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
    baseURL: process.env.NIM_BASE_URL ?? DEFAULT_BASE_URL,
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

/** One raw chat-completion call. */
export async function callModel(messages: ChatMessage[]): Promise<RawCall> {
  const started = Date.now();
  const model = modelId();
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: MAX_COMPLETION_TOKENS,
  };
  if (model.includes("glm") || model.includes("flash")) {
    (params as unknown as Record<string, unknown>).reasoning_effort = "low";
  }

  const { data, response } = await getClient().chat.completions
    .create(params)
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

/** Real-time token streaming using the OpenAI SDK. */
export async function* streamModel(messages: ChatMessage[]): AsyncGenerator<string, void, unknown> {
  const model = modelId();
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: MAX_COMPLETION_TOKENS,
    stream: true,
  };
  if (model.includes("glm") || model.includes("flash")) {
    (params as unknown as Record<string, unknown>).reasoning_effort = "low";
  }

  const stream = await getClient().chat.completions.create(params);
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) yield delta;
  }
}

/** Pull the JSON object out of a reply that may carry fences or stray prose. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseReceiptsTag(text: string): {
  memoryUsed: boolean;
  sources: EnvelopeSource[];
  content: string;
} {
  const match = text.match(/<receipts\s+memory_used=["'](true|false)["']\s+sources=(?:'([^']*)'|"([^"]*)")\s*\/?>/i);
  if (!match) {
    return { memoryUsed: false, sources: [], content: text };
  }

  const memoryUsed = match[1] === "true";
  const sourcesRaw = match[2] ?? match[3] ?? "[]";
  let sources: EnvelopeSource[] = [];
  try {
    const parsed = JSON.parse(sourcesRaw);
    if (Array.isArray(parsed)) {
      sources = parsed.map((s) => ({
        session_id: Number(s.session_id) || 0,
        date: String(s.date || ""),
        taken: String(s.taken || ""),
        why_now: String(s.why_now || ""),
      }));
    }
  } catch {}

  const content = text.slice(match[0].length).trimStart();
  return { memoryUsed, sources, content };
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
  return {
    answer,
    memory_used: obj.memory_used === true,
    sources,
    onboarding_complete:
      typeof obj.onboarding_complete === "boolean"
        ? obj.onboarding_complete
        : undefined,
  };
}

/**
 * The answer call: system prompt + conversation in, envelope out.
 * One repair re-prompt on malformed JSON; after that the caller degrades
 * gracefully to plain text without a panel (spec.md > Important Failure Modes).
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
      // Degrade gracefully per spec.md > Important Failure Modes
      return {
        envelope: {
          answer: repair.raw || first.raw,
          memory_used: false,
          sources: [],
        },
        meta: repair,
      };
    }
  }
}
