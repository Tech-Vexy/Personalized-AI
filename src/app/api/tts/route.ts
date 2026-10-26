import fs from "fs";
import path from "path";
import crypto from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_DIR = path.join(process.cwd(), "data", "audio-cache");

function getCachePath(voiceId: string, modelId: string, text: string): string {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const hash = crypto
    .createHash("sha256")
    .update(`${voiceId}:${modelId}:${text}`)
    .digest("hex");
  return path.join(CACHE_DIR, `${hash}.wav`);
}

function stripMarkdownForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "Code block omitted.") // Replace code blocks
    .replace(/`([^`]+)`/g, "$1")                      // Inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")         // Images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")          // Links
    .replace(/[#*_~`>-]/g, " ")                       // Markdown syntax characters
    .replace(/\s+/g, " ")                             // Collapse spaces
    .trim();
}

/**
 * Cartesia Text-to-Speech (TTS) route with persistent disk caching.
 * Prevents redundant API costs by hashing voiceId + modelId + text.
 */
export async function POST(req: Request) {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "CARTESIA_API_KEY is not configured on the server", fallback: true },
      { status: 501 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      text?: string;
      voiceId?: string;
    };

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    const cleanText = stripMarkdownForSpeech(text).slice(0, 4000);
    const voiceId =
      body.voiceId ||
      process.env.CARTESIA_VOICE_ID ||
      "62ae83ad-4f6a-430b-af41-a9bede9286ca"; // Gemma - Decisive Agent
    const modelId = process.env.CARTESIA_MODEL || "sonic-3.6";

    // 1. Check local audio disk cache
    const cacheFile = getCachePath(voiceId, modelId, cleanText);
    if (fs.existsSync(cacheFile)) {
      try {
        const cachedBuf = fs.readFileSync(cacheFile);
        return new Response(cachedBuf, {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "Content-Length": cachedBuf.byteLength.toString(),
            "X-Audio-Cache": "HIT",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch (readErr) {
        console.warn("[tts cache] Failed to read cached file:", readErr);
      }
    }

    // 2. Cache miss -> Call Cartesia API
    const cartesiaUrl = "https://api.cartesia.ai/tts/bytes";
    const response = await fetch(cartesiaUrl, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: modelId,
        transcript: cleanText,
        voice: {
          mode: "id",
          id: voiceId,
        },
        output_format: {
          container: "wav",
          encoding: "pcm_s16le",
          sample_rate: 24000,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[cartesia] TTS error:", response.status, errText);
      return Response.json(
        { error: `Cartesia API error (${response.status})`, details: errText },
        { status: response.status },
      );
    }

    const audioArrayBuffer = await response.arrayBuffer();

    // 3. Persist to disk cache
    try {
      fs.writeFileSync(cacheFile, Buffer.from(audioArrayBuffer));
    } catch (writeErr) {
      console.warn("[tts cache] Failed to write cache file:", writeErr);
    }

    return new Response(audioArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": audioArrayBuffer.byteLength.toString(),
        "X-Audio-Cache": "MISS",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("[cartesia] TTS exception:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to generate speech" },
      { status: 500 },
    );
  }
}
