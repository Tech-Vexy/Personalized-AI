import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, sessions, type MessageRow, type SessionRow } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function toWireSession(row: SessionRow) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
 * GET /api/sessions       → every session, newest activity first.
 * GET /api/sessions?id=N  → one session with its messages.
 * Slice 2 uses the "latest session" read so a restart reopens the live
 * conversation; the history drawer builds on this route in slice 6.
 */
export function GET(req: Request) {
  const idParam = new URL(req.url).searchParams.get("id");
  if (idParam === null) {
    const rows = db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt), desc(sessions.id))
      .all();
    return Response.json({ sessions: rows.map(toWireSession) });
  }

  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  const session = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.id))
    .all();
  return Response.json({ session: toWireSession(session), messages: rows.map(toWireMessage) });
}
