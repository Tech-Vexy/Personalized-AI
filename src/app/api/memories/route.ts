import { desc, eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { memories, sessions } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/memories
 * Lists all long-term memories in the knowledge vault with session provenance.
 */
export function GET() {
  const rows = sqlite
    .prepare(
      `SELECT m.id               AS id,
              m.content          AS content,
              m.source_session_id AS sessionId,
              COALESCE(s.title, 'Direct memory') AS sessionTitle,
              m.created_at       AS createdAt
       FROM memories m
       LEFT JOIN sessions s ON m.source_session_id = s.id
       ORDER BY m.id DESC`,
    )
    .all() as Array<{
    id: number;
    content: string;
    sessionId: number;
    sessionTitle: string;
    createdAt: number;
  }>;

  const formatted = rows.map((r) => ({
    id: r.id,
    content: r.content,
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle,
    createdAt: new Date(r.createdAt).toISOString(),
    date: new Date(r.createdAt).toISOString().slice(0, 10),
  }));

  return Response.json({ memories: formatted, count: formatted.length });
}

/**
 * POST /api/memories
 * Manually add a durable memory directly into the memory vault and FTS index.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { content, sessionId } = (body ?? {}) as {
    content?: unknown;
    sessionId?: unknown;
  };

  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  let targetSessionId = Number(sessionId);
  if (!Number.isInteger(targetSessionId) || targetSessionId <= 0) {
    // If no session specified, attach to most recent session or create an anchor session
    const last = db.select().from(sessions).orderBy(desc(sessions.id)).limit(1).get();
    if (last) {
      targetSessionId = last.id;
    } else {
      const created = db.insert(sessions).values({ title: "Memory Vault Direct" }).returning().get();
      targetSessionId = created.id;
    }
  }

  const now = Date.now();
  const insertMemory = sqlite.prepare(
    "INSERT INTO memories (content, source_session_id, created_at) VALUES (?, ?, ?)",
  );
  const insertFts = sqlite.prepare(
    "INSERT INTO memories_fts (rowid, content) VALUES (?, ?)",
  );

  const info = insertMemory.run(text, targetSessionId, now);
  const newId = Number(info.lastInsertRowid);
  insertFts.run(newId, text);

  return Response.json({
    success: true,
    memory: {
      id: newId,
      content: text,
      sessionId: targetSessionId,
      createdAt: new Date(now).toISOString(),
      date: new Date(now).toISOString().slice(0, 10),
    },
  });
}

/**
 * DELETE /api/memories?id=N
 * Delete a specific memory from both the relational table and FTS index.
 */
export function DELETE(req: Request) {
  const idParam = new URL(req.url).searchParams.get("id");
  if (!idParam) {
    return Response.json({ error: "id parameter is required" }, { status: 400 });
  }
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid memory id" }, { status: 400 });
  }

  sqlite.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(id);
  sqlite.prepare("DELETE FROM memories WHERE id = ?").run(id);

  return Response.json({ success: true, deletedId: id });
}
