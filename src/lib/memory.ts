import { sqlite } from "./db";
import { callModel } from "./llm";

/**
 * The kernel's memory module (spec.md > Components > Recall engine):
 * - keyword recall over the FTS5 index with a bm25 relevance floor,
 * - the extraction call that distills durable memories after each turn
 *   (an extraction failure never fails the user-facing turn),
 * - FTS writes kept rowid-aligned with memories.id (spec.md > Data Model).
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "because", "as",
  "of", "at", "by", "for", "with", "about", "into", "to", "from", "in", "on",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "i", "you", "he", "she", "it", "we", "they", "me",
  "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those", "what", "which", "who", "whom", "how",
  "when", "where", "why", "not", "no", "yes", "can", "could", "should",
  "would", "will", "shall", "may", "might", "must", "just", "also", "very",
  "really", "some", "any", "all", "get", "got", "make", "made", "like",
  "want", "need", "know", "think", "thought", "there", "here", "than",
]);

/**
 * The relevance floor: bm25() in SQLite FTS5 returns smaller (more negative)
 * values for better matches. Tuned against scripts/seed.ts — the quality bar
 * is that a distinctive phrase surfaces its session's memory while generic
 * messages trigger nothing (spec.md > Decisions and Open Issues).
 */
export const BM25_FLOOR = -0.6;

export type RecalledMemory = {
  memoryId: number;
  sessionId: number;
  date: string;
  content: string;
  rank: number;
};

/** Distinctive words from the user's message — the recall query terms. */
export function keywordsFrom(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

/**
 * Recall: FTS5 MATCH from the user's words → bm25 ranking → relevance floor
 * → memories with session provenance. The current session is excluded —
 * its content is already in the short-term history window.
 */
export function recallMemories(
  userMessage: string,
  excludeSessionId?: number,
): RecalledMemory[] {
  const words = keywordsFrom(userMessage);
  if (words.length === 0) return [];
  const match = words.map((w) => `"${w}"`).join(" OR ");
  const rows = sqlite
    .prepare(
      `SELECT m.id          AS memoryId,
              m.content     AS content,
              m.source_session_id AS sessionId,
              s.created_at  AS createdAt,
              bm25(memories_fts) AS rank
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       JOIN sessions s ON s.id = m.source_session_id
       WHERE memories_fts MATCH ?
       ORDER BY rank
       LIMIT 8`,
    )
    .all(match) as Array<{
    memoryId: number;
    content: string;
    sessionId: number;
    createdAt: number;
    rank: number;
  }>;
  return rows
    .filter((r) => r.rank <= BM25_FLOOR && r.sessionId !== excludeSessionId)
    .map((r) => ({
      memoryId: r.memoryId,
      sessionId: r.sessionId,
      date: new Date(r.createdAt).toISOString().slice(0, 10),
      content: r.content,
      rank: r.rank,
    }));
}

const EXTRACTION_SYSTEM = `You distill durable long-term memories from one exchange with the user. Reply with ONLY a JSON object — no markdown fences, no text before or after it:
{"memories": ["..."]}
- At most 3 short third-person statements (under 200 characters each) capturing facts, decisions, preferences, projects, goals, or commitments worth carrying into future conversations.
- Never include small talk, transient states, or speculation.
- If nothing qualifies, return {"memories": []}.`;

/**
 * The extraction call: distills the finished exchange into durable memories
 * and writes them (and the FTS index). Throws on model/parse failure —
 * the chat route catches and moves on; the user-facing turn never waits
 * on or fails because of this.
 */
export async function extractMemories(params: {
  sessionId: number;
  userMessage: string;
  assistantReply: string;
}): Promise<string[]> {
  const { raw } = await callModel([
    { role: "system", content: EXTRACTION_SYSTEM },
    {
      role: "user",
      content: `User said: ${params.userMessage}\n\nYou replied: ${params.assistantReply}`,
    },
  ]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let obj: { memories?: unknown };
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as { memories?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(obj.memories)) return [];

  const written: string[] = [];
  const find = sqlite.prepare("SELECT id FROM memories WHERE content = ?");
  const insertMemory = sqlite.prepare(
    "INSERT INTO memories (content, source_session_id, created_at) VALUES (?, ?, ?)",
  );
  const insertFts = sqlite.prepare(
    "INSERT INTO memories_fts (rowid, content) VALUES (?, ?)",
  );
  for (const m of obj.memories.slice(0, 3)) {
    if (typeof m !== "string") continue;
    const content = m.trim().slice(0, 200);
    if (!content) continue;
    if (find.get(content)) continue; // exact duplicate — skip (PoC-sized dedup)
    const info = insertMemory.run(content, params.sessionId, Date.now());
    insertFts.run(Number(info.lastInsertRowid), content);
    written.push(content);
  }
  return written;
}


export type PriorDeliverable = {
  sessionId: number;
  sessionTitle: string;
  date: string;
  userRequest: string;
  assistantSummary: string;
};

/**
 * Repetition guard: bounded LIKE scan over past messages from earlier sessions
 * to detect repeated requests for already-produced deliverables (spec.md > Components > Recall engine).
 */
export function findPriorDeliverables(
  userMessage: string,
  excludeSessionId?: number,
): PriorDeliverable[] {
  const words = keywordsFrom(userMessage);
  if (words.length === 0) return [];

  const candidates: PriorDeliverable[] = [];

  for (const word of words.slice(0, 4)) {
    const rows = sqlite
      .prepare(
        `SELECT m.id AS msgId,
                m.session_id AS sessionId,
                m.role AS role,
                m.content AS content,
                m.created_at AS createdAt,
                s.title AS sessionTitle
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.session_id != ?
           AND m.role = 'user'
           AND lower(m.content) LIKE ?
         ORDER BY m.id DESC
         LIMIT 3`,
      )
      .all(excludeSessionId ?? 0, `%${word.toLowerCase()}%`) as Array<{
      msgId: number;
      sessionId: number;
      role: string;
      content: string;
      createdAt: number;
      sessionTitle: string;
    }>;

    for (const row of rows) {
      const assistantMsg = sqlite
        .prepare(
          `SELECT content FROM messages
           WHERE session_id = ? AND role = 'assistant' AND id > ?
           ORDER BY id ASC LIMIT 1`,
        )
        .get(row.sessionId, row.msgId) as { content: string } | undefined;

      if (assistantMsg && assistantMsg.content) {
        const summary = assistantMsg.content.slice(0, 280);
        const date = new Date(row.createdAt).toISOString().slice(0, 10);
        if (!candidates.some((c) => c.sessionId === row.sessionId)) {
          candidates.push({
            sessionId: row.sessionId,
            sessionTitle: row.sessionTitle,
            date,
            userRequest: row.content,
            assistantSummary: summary,
          });
        }
      }
    }
  }

  return candidates.slice(0, 2);
}
