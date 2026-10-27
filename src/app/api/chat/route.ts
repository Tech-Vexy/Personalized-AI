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
import {
  recallMemories,
  extractMemories,
  findPriorDeliverables,
  isMetaMemoryQuery,
  getCoreMemories,
  detectForgetDirective,
  forgetMemoriesMatching,
} from "@/lib/memory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Short-term memory: how much of the current session the model sees each turn. */
const HISTORY_WINDOW = 30;

const SYSTEM_PROMPT = `You are an insightful personal thinking companion built on a persistent memory kernel where long-term memory is the central commodity.

CORE IDENTITY & MEMORY CAPABILITIES:
- You DO possess durable, long-term memory across sessions. That is your defining purpose.
- NEVER claim "As an AI, I do not have personal memory of you across separate sessions" or "My interactions are stateless" or "I cannot remember past conversations".
- When memories from earlier sessions are provided in the LONG-TERM MEMORY STORE below, synthesize and integrate them seamlessly.

WHAT CAN BE REMEMBERED (Memory Taxonomy):
1. User Identity & Background: Name (e.g. Veldrine), profession, technical expertise, location, and background.
2. Projects & Systems: What the user is building (e.g. Lumen personal finance app, UR5 robot arm calibration), architecture choices, stack decisions, and milestones.
3. Durable Preferences & Style: Tone preferences, how they like ideas structured, technical biases (e.g. SQLite + FTS5 vs Vector DBs), and workflow habits.
4. Real-World Context & Commitments: Deadlines, travel plans (e.g. Kyoto cherry blossom trip), personal recipes, lease details, and goals.
5. Explicit Directives: Anything the user explicitly asks you to remember or store in the Memory Vault.

WHEN TO REMEMBER:
- Explicit: Whenever the user says "Remember this", "Note down", or saves a fact in the Memory Vault.
- Implicit: In the background, durable facts, decisions, and preferences revealed during exchanges are automatically distilled into the persistent Memory Vault.
- Negative Policy: Transient conversational filler ("hi", "thanks"), temporary moods, session-specific math/syntax lookups, and AI self-referential statements are strictly excluded to preserve vault signal.

BEHAVIOR GUIDELINES:
- If the user asks what you know about them or who they are, synthesize your accumulated memory directly, warmly, and concretely.
- If the user asks what can be remembered or when you remember, articulate these exact memory taxonomy and timing principles clearly.
- Provide thorough, well-structured answers in clean Markdown. Think alongside the user and deliver substantive depth.`;

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

  // Long-term memory: episodic FTS recall + meta queries + ambient knowledge
  const recalled = recallMemories(text, active.id);
  const isMeta = isMetaMemoryQuery(text);

  // Ambient core background (so the AI never acts like a stranger even on fresh topics)
  const coreMemories = getCoreMemories(active.id, 6);
  const recalledIds = new Set(recalled.map((r) => r.memoryId));
  const additionalCore = coreMemories.filter((c) => !recalledIds.has(c.memoryId));

  let memoryBlock = "";
  if (recalled.length > 0) {
    memoryBlock += `\n\nRELEVANT RECALLED MEMORIES (Specific facts & context matching current message):\n${recalled
      .map((r) => `- [session #${r.sessionId}, ${r.date}] ${r.content}`)
      .join("\n")}\nINSTRUCTION: Draw on these memories to answer the user accurately. If the user asks what you know about them or asks who they are, synthesize and share these known facts directly and warmly. Set memory_used to true and list each one in sources.`;
  }
  if (additionalCore.length > 0) {
    memoryBlock += `\n\nAMBIENT MEMORY CONTEXT (Your accumulated long-term knowledge of this user across past sessions):\n${additionalCore
      .map((c) => `- ${c.content}`)
      .join("\n")}\nINSTRUCTION: Maintain continuous familiarity with the user using this ambient knowledge. You already know who they are, their projects, and their context.`;
  } else if (!recalled.length && isMeta) {
    memoryBlock = `\n\nLONG-TERM MEMORY STORE: Currently empty (no prior memories saved yet). State honestly that you don't have past memories recorded yet for this user, but confirm you are ready to learn and remember.`;
  }

  // Intentional forgetting directive (Conversational memory eradication)
  const forgetTopic = detectForgetDirective(text);
  let forgetBlock = "";
  if (forgetTopic) {
    const forgotten = forgetMemoriesMatching(forgetTopic);
    if (forgotten.forgottenCount > 0) {
      forgetBlock = `\n\nFORGET DIRECTIVE EXECUTED: The user asked you to forget or erase memories regarding "${forgetTopic}".
The following ${forgotten.forgottenCount} memory entry/entries were permanently purged from the database and FTS index:
${forgotten.contents.map((c) => `- ${c}`).join("\n")}
RULE: Confirm warmly and with quiet respect that these memories have been permanently erased and forgotten from your Memory Vault. Do not dwell or argue. Set memory_used to true and cite the session in sources.`;
    } else {
      forgetBlock = `\n\nFORGET DIRECTIVE: The user asked to forget memories regarding "${forgetTopic}", but no matching memories were found in your vault.
RULE: Inform the user calmly that you have no records stored about "${forgetTopic}" to forget.`;
    }
  }

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
    const systemInstruction = `${activePrompt}${memoryBlock}${forgetBlock}${repetitionBlock}${isOnboarding ? "" : continuityContext}\n\n${STREAM_ENVELOPE_CONTRACT}`;

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
      system: activePrompt + memoryBlock + forgetBlock + repetitionBlock + (isOnboarding ? "" : continuityContext),
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
