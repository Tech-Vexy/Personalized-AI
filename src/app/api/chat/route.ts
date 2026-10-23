import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, sessions, type MessageRow, type SessionRow } from "@/lib/schema";
import { answerWithEnvelope, type ChatMessage } from "@/lib/llm";
import { recallMemories, extractMemories } from "@/lib/memory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Short-term memory: how much of the current session the model sees each turn. */
const HISTORY_WINDOW = 30;

const SYSTEM_PROMPT = `You are a personal thinking companion: original, direct, no flattery, no unwarranted critique. Think with the user, not for them.
Write calm, plain markdown — short paragraphs, generous breathing room, lists only when they earn their place.`;

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
 * One chat turn: persist user message → recall long-term memories →
 * prompt (history + recalled memories) → envelope → persist answer →
 * fire-and-forget memory extraction → return JSON.
 * The surface is stateless; sessions are internal kernel structure.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { message, sessionId } = (body ?? {}) as { message?: unknown; sessionId?: unknown };
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
  // with session provenance. The current session is excluded — its content
  // is already in the history window above.
  const recalled = recallMemories(text, active.id);
  const memoryBlock = recalled.length
    ? `\n\nLong-term memories from earlier sessions with this user, most relevant first (format: [session #id, date] content):\n${recalled
        .map((r) => `- [session #${r.sessionId}, ${r.date}] ${r.content}`)
        .join("\n")}\n\nDraw on these only when they genuinely bear on the current message. If you use any of them in your reply, set memory_used to true and list each one you used in sources as {"session_id": <number>, "date": "<YYYY-MM-DD>", "taken": "<what you took>", "why_now": "<why it matters here>"}. If none of them bear on this message, ignore them and keep memory_used false.`
    : "";

  // Persist the user message. A failed turn appends nothing else — the
  // pending message lives in client state until an answer exists.
  const userRow = db
    .insert(messages)
    .values({ sessionId: active.id, role: "user", content: text })
    .returning()
    .get();
  if (!userRow) {
    return Response.json({ error: "could not save the message" }, { status: 500 });
  }

  try {
    const { envelope } = await answerWithEnvelope({
      system: SYSTEM_PROMPT + memoryBlock,
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
    // Fire-and-forget extraction: the answer is already saved and returned,
    // so a failed or slow distillation never blocks or fails the user-facing
    // turn (spec.md > Important Failure Modes). Local PoC: the floating
    // promise completes in the long-running dev server process.
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
    });
  } catch (error) {
    // Undo the partial turn so the store stays clean; the client keeps the
    // pending message and can retry it (spec.md > Important Failure Modes).
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
