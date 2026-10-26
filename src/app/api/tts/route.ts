export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
 * Cartesia Text-to-Speech (TTS) route.
 * Converts assistant message text into expressive, ultra-low latency speech via Cartesia Sonic.
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

    const cartesiaUrl = "https://api.cartesia.ai/tts/bytes";
    const response = await fetch(cartesiaUrl, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: process.env.CARTESIA_MODEL || "sonic-3.6",
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
    return new Response(audioArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": audioArrayBuffer.byteLength.toString(),
        "Cache-Control": "public, max-age=3600",
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
