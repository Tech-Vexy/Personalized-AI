import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, messages, sessions, type MessageRow, type SessionRow } from "@/lib/schema";

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

/**
 * DELETE /api/sessions?id=N → delete a session and its associated messages.
 */
export function DELETE(req: Request) {
  const idParam = new URL(req.url).searchParams.get("id");
  if (!idParam) {
    return Response.json({ error: "id parameter is required" }, { status: 400 });
  }
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }

  // Cascading deletes
  db.delete(messages).where(eq(messages.sessionId, id)).run();
  db.delete(memories).where(eq(memories.sourceSessionId, id)).run();
  const deleted = db.delete(sessions).where(eq(sessions.id, id)).run();

  return Response.json({ success: true, deletedId: id });
}
