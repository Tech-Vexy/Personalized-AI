import { asc, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, messages, profile, sessions, type MessageRow, type SessionRow } from "@/lib/schema";
import {
  answerWithEnvelope,
  parseReceiptsTag,
  streamModel,
  STREAM_ENVELOPE_CONTRACT,
  type ChatMessage,
  type EnvelopeSource,
} from "@/lib/llm";
import { recallMemories, extractMemories, findPriorDeliverables } from "@/lib/memory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Short-term memory: how much of the current session the model sees each turn. */
const HISTORY_WINDOW = 30;

const SYSTEM_PROMPT = `You are an insightful, highly competent personal thinking companion: original, direct, thoughtful, and genuinely helpful.
You provide thorough, comprehensive, and well-developed answers. When exploring topics or addressing questions:
- Provide depth, clarity, and complete explanations rather than brief surface-level summaries.
- Unpack complex nuances, provide concrete examples, structure solutions, and offer actionable insights.
- Do not make the user do all the heavy lifting by withholding substantive thoughts or asking superficial questions. Deliver real intellectual value and completeness in every turn.
- Format with clean, readable Markdown (headings, clear paragraphs, code blocks, or structured lists when appropriate).`;

const ONBOARDING_SYSTEM_PROMPT = `You are a personal thinking companion having a brief, welcoming first conversation with the user to get to know them.
Ask a few foundational facts about them (their name or how to address them, what projects or thinking they focus on, and how they like to work together) ONE question at a time.
Keep your tone calm, direct, and conversational. Do not present a numbered form or long list of questions.
When you have learned 2-3 key facts and have enough to start working together, set "onboarding_complete": true in your JSON envelope and welcome them. Otherwise set "onboarding_complete": false.`;

/** Titles come from the first user words (spec.md > Data Model). */
function deriveTitle(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}…`;
}

function toWireMessage(row: MessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Continuity trigger check: case-insensitive literal match on
 * "let's continue" / "lets continue" / "let us continue"
 * (spec.md > Components > Continuity responder).
 */
export function isContinuityTrigger(text: string): boolean {
  const norm = text.toLowerCase().trim().replace(/[.,!?;:]+$/, "");
  return norm === "let's continue" || norm === "lets continue" || norm === "let us continue";
}

/**
 * One chat turn: persist user message → recall long-term memories →
 * prompt (history + recalled memories + continuity/repetition if triggered) →
 * returns either a real-time SSE stream (stream: true) or a structured envelope JSON.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { message, sessionId, onboarding, stream } = (body ?? {}) as {
    message?: unknown;
    sessionId?: unknown;
    onboarding?: unknown;
    stream?: unknown;
  };
  const isOnboarding = onboarding === true;
  const isStreaming = stream === true;
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  // Resolve or create the active session.
  let session: SessionRow | null =
    typeof sessionId === "number" && Number.isInteger(sessionId) && sessionId > 0
      ? (db.select().from(sessions).where(eq(sessions.id, sessionId)).get() ?? null)
      : null;
  const createdSession = session === null;
  if (!session) {
    const inserted = db.insert(sessions).values({ title: deriveTitle(text) }).returning().get();
    if (!inserted) {
      return Response.json({ error: "could not create the session" }, { status: 500 });
    }
    session = inserted;
  }
  const active: SessionRow = session;

  // Short-term memory: the session's recent messages, before this turn.
  const recent = db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, active.id))
    .orderBy(asc(messages.id))
    .all();
  const history: ChatMessage[] = recent
    .slice(-HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }));

  // Long-term memory: keyword recall over the FTS index, relevance-floored,
  // with session provenance. The current session is excluded.
  const recalled = recallMemories(text, active.id);
  const memoryBlock = recalled.length
    ? `\n\nLong-term memories from earlier sessions with this user, most relevant first (format: [session #id, date] content):\n${recalled
        .map((r) => `- [session #${r.sessionId}, ${r.date}] ${r.content}`)
        .join("\n")}\n\nDraw on these only when they genuinely bear on the current message. If you use any of them in your reply, set memory_used to true and list each one in sources. If none bear on this message, keep memory_used false.`
    : "";

  // Repetition guard (spec.md > Components > Recall engine):
  const priorDeliverables = findPriorDeliverables(text, active.id);
  const repetitionBlock = priorDeliverables.length
    ? `\n\nREPETITION GUARD: The user may be repeating a prior request that was already handled in an earlier conversation.
Prior matches found in earlier sessions:
${priorDeliverables
  .map(
    (p) =>
      `- [session #${p.sessionId}, ${p.date}] "${p.sessionTitle}": User asked: "${p.userRequest}". Produced: "${p.assistantSummary}..."`,
  )
  .join("\n")}

RULE: If the user is asking again for this same deliverable or outcome, POINT BACK to the original session and its date/content instead of regenerating a fresh variant from scratch (e.g. "You asked for this on ${priorDeliverables[0].date} in our session on '${priorDeliverables[0].sessionTitle}' — here is what was made: ..."). Set memory_used to true and cite the session in sources. If this is a new or distinct request, proceed normally.`
    : "";

  // Continuity responder (spec.md > Components > Continuity responder):
  let continuityContext = "";
  if (createdSession && isContinuityTrigger(text)) {
    const lastSession = db
      .select()
      .from(sessions)
      .where(ne(sessions.id, active.id))
      .orderBy(desc(sessions.updatedAt))
      .limit(1)
      .get();

    if (lastSession) {
      const lastMessages = db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, lastSession.id))
        .orderBy(asc(messages.id))
        .all();
      const lastMems = db
        .select()
        .from(memories)
        .where(eq(memories.sourceSessionId, lastSession.id))
        .all();

      if (lastMessages.length > 0) {
        const sessionDate = new Date(lastSession.updatedAt).toISOString().slice(0, 10);
        continuityContext = `\n\nSESSION CONTINUITY PICKUP: The user opened a fresh session and said "${text}".
You are resuming from their previous conversation (session #${lastSession.id}, "${lastSession.title}", dated ${sessionDate}).
Tail of that conversation:
${lastMessages.slice(-6).map((m) => `[${m.role}]: ${m.content}`).join("\n")}
${lastMems.length ? `\nDistilled key facts from that session:\n${lastMems.map((m) => `- ${m.content}`).join("\n")}` : ""}

YOUR INSTRUCTION: Summarize where the last session left off (e.g. "Yesterday we looked at..., today...") and propose a concrete, thoughtful next step unprompted. If you draw on that session, set memory_used to true and cite it in sources.`;
      }
    }

    if (!continuityContext) {
      continuityContext = `\n\nSESSION CONTINUITY PICKUP: The user said "${text}", but there are no prior conversations or sessions in memory (empty store).
RULE: Do NOT invent or fabricate any prior topics, yesterday's work, or fake context. State calmly that this is our first conversation together, and ask a direct, friendly clarifying question asking what they would like to focus on or continue with. Keep memory_used false.`;
    }
  }

  // Persist the user message.
  const userRow = db
    .insert(messages)
    .values({ sessionId: active.id, role: "user", content: text })
    .returning()
    .get();
  if (!userRow) {
    return Response.json({ error: "could not save the message" }, { status: 500 });
  }

  const activePrompt = isOnboarding ? ONBOARDING_SYSTEM_PROMPT : SYSTEM_PROMPT;

  // Handle Real-Time Token Streaming (SSE)
  if (isStreaming) {
    const encoder = new TextEncoder();
    const systemInstruction = `${activePrompt}${memoryBlock}${repetitionBlock}${isOnboarding ? "" : continuityContext}\n\n${STREAM_ENVELOPE_CONTRACT}`;

    const readable = new ReadableStream({
      async start(controller) {
        let fullReply = "";
        let buffer = "";
        let headerParsed = false;
        let memoryUsed = false;
        let sources: EnvelopeSource[] = [];

        try {
          const streamGen = streamModel([
            { role: "system", content: systemInstruction },
            ...history,
            { role: "user", content: text },
          ]);

          for await (const chunk of streamGen) {
            if (!headerParsed) {
              buffer += chunk;
              if (buffer.includes("/>") || buffer.includes("\n") || buffer.length > 200) {
                const parsed = parseReceiptsTag(buffer);
                memoryUsed = parsed.memoryUsed;
                sources = parsed.sources;
                headerParsed = true;

                controller.enqueue(
                  encoder.encode(`event: metadata\ndata: ${JSON.stringify({ memoryUsed, sources })}\n\n`),
                );

                if (parsed.content) {
                  fullReply += parsed.content;
                  controller.enqueue(
                    encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: parsed.content })}\n\n`),
                  );
                }
              }
            } else {
              fullReply += chunk;
              controller.enqueue(
                encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`),
              );
            }
          }

          if (!headerParsed) {
            const parsed = parseReceiptsTag(buffer);
            memoryUsed = parsed.memoryUsed;
            sources = parsed.sources;
            fullReply = parsed.content;
            controller.enqueue(
              encoder.encode(`event: metadata\ndata: ${JSON.stringify({ memoryUsed, sources })}\n\n`),
            );
            if (fullReply) {
              controller.enqueue(
                encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: fullReply })}\n\n`),
              );
            }
          }

          const cleanReply = fullReply.trim();
          const assistantRow = db
            .insert(messages)
            .values({ sessionId: active.id, role: "assistant", content: cleanReply })
            .returning()
            .get();

          if (assistantRow) {
            db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, active.id)).run();

            void extractMemories({
              sessionId: active.id,
              userMessage: text,
              assistantReply: cleanReply,
            }).catch((err) => {
              console.error("[memory] extraction skipped:", err);
            });

            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  sessionId: active.id,
                  userMessage: toWireMessage(userRow),
                  assistantMessage: toWireMessage(assistantRow),
                  memoryUsed,
                  sources,
                })}\n\n`,
              ),
            );
          }
        } catch (err) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : "Stream error" })}\n\n`),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  }

  // Non-streaming fallback
  try {
    const { envelope } = await answerWithEnvelope({
      system: activePrompt + memoryBlock + repetitionBlock + (isOnboarding ? "" : continuityContext),
      history,
      userMessage: text,
    });
    const assistantRow = db
      .insert(messages)
      .values({ sessionId: active.id, role: "assistant", content: envelope.answer })
      .returning()
      .get();
    if (!assistantRow) {
      return Response.json({ error: "could not save the reply" }, { status: 500 });
    }
    db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, active.id)).run();

    if (envelope.onboarding_complete) {
      db.insert(profile)
        .values({ key: "onboarding_done", value: "true" })
        .onConflictDoUpdate({
          target: profile.key,
          set: { value: "true" },
        })
        .run();
    }

    void extractMemories({
      sessionId: active.id,
      userMessage: text,
      assistantReply: envelope.answer,
    }).catch((err: unknown) => {
      console.error(
        "[memory] extraction skipped:",
        err instanceof Error ? err.message : err,
      );
    });

    return Response.json({
      sessionId: active.id,
      userMessage: toWireMessage(userRow),
      assistantMessage: toWireMessage(assistantRow),
      memoryUsed: envelope.memory_used,
      sources: envelope.sources,
      onboardingComplete: envelope.onboarding_complete === true,
    });
  } catch (error) {
    db.delete(messages).where(eq(messages.id, userRow.id)).run();
    if (createdSession) {
      db.delete(sessions).where(eq(sessions.id, active.id)).run();
    }
    const status = (error as { status?: number }).status;
    const detail = error instanceof Error ? error.message : "the model call failed";
    const prefix = status === 401 ? "The model rejected the API key." : "The model call did not succeed.";
    return Response.json({ error: `${prefix} ${detail}` }, { status: 502 });
  }
}
