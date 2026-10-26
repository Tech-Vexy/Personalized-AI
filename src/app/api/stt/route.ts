export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Deepgram Speech-to-Text (STT) route.
 * Accepts raw audio (webm, wav, ogg, etc.) and forwards to Deepgram Nova-2.
 */
export async function POST(req: Request) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "DEEPGRAM_API_KEY is not configured on the server", fallback: true },
      { status: 501 },
    );
  }

  try {
    const contentType = req.headers.get("content-type") || "audio/webm";
    const audioBuffer = await req.arrayBuffer();

    if (!audioBuffer || audioBuffer.byteLength === 0) {
      return Response.json({ error: "No audio data received" }, { status: 400 });
    }

    const deepgramUrl =
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true";

    const response = await fetch(deepgramUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": contentType,
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[deepgram] STT error:", response.status, errorText);
      return Response.json(
        { error: `Deepgram API error (${response.status})`, details: errorText },
        { status: response.status },
      );
    }

    const data = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
          }>;
        }>;
      };
    };

    const transcript =
      data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";

    return Response.json({ transcript, provider: "deepgram" });
  } catch (err) {
    console.error("[deepgram] transcription exception:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to process audio" },
      { status: 500 },
    );
  }
}
