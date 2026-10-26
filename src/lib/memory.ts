import { sqlite } from "./db";
import { callModel } from "./llm";

/**
 * The kernel's memory module (spec.md > Components > Recall engine):
 * - keyword recall over the FTS5 index with a bm25 relevance floor,
 * - enhanced prefix & inflection matching ("term"* in SQLite FTS5),
 * - smart extraction gating (avoids wasting LLM calls on greetings & trivial chatter),
 * - fuzzy deduplication to prevent repetitive fragmented memories,
 * - bounded repetition scan over past deliverable requests.
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
  "tell", "give", "show", "help", "please", "thanks", "thank", "okay",
]);

/**
 * The relevance floor: bm25() in SQLite FTS5 returns smaller (more negative)
 * values for better matches.
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
 * Checks if the user is asking a meta-memory question about what the AI knows or remembers
 * (e.g. "What do you know about me?", "Who am I?", "What do you remember about our work?").
 */
export function isMetaMemoryQuery(text: string): boolean {
  const norm = text.toLowerCase().trim().replace(/[.,!?;:'"’“”]/g, " ");
  const patterns = [
    /what\s+(do\s+you\s+)?know\s+(about\s+)?(me|myself)/i,
    /what\s+(do\s+you\s+)?remember(\s+about\s+(me|us))?/i,
    /who\s+am\s+i/i,
    /what\s+is\s+my\s+name/i,
    /whats\s+my\s+name/i,
    /tell\s+me\s+about\s+(myself|me)/i,
    /what\s+have\s+we\s+(talked|discussed|worked|done)/i,
    /what\s+are\s+my\s+(projects|interests|goals)/i,
    /do\s+you\s+(know|remember)\s+me/i,
    /what\s+is\s+in\s+(your|my)\s+memory/i,
    /summarize\s+what\s+you\s+know/i,
  ];
  return patterns.some((p) => p.test(norm));
}

/**
 * Recall: FTS5 MATCH with prefix wildcards (e.g. "financ"* matches "finance" and "financial")
 * → bm25 ranking → relevance floor → memories with session provenance.
 * For meta-memory questions, returns all durable profile and project memories.
 */
export function recallMemories(
  userMessage: string,
  excludeSessionId?: number,
): RecalledMemory[] {
  // If the user asks what we know/remember about them, surface all durable memories directly
  if (isMetaMemoryQuery(userMessage)) {
    const allRows = sqlite
      .prepare(
        `SELECT m.id          AS memoryId,
                m.content     AS content,
                m.source_session_id AS sessionId,
                s.created_at  AS createdAt,
                -2.0          AS rank
         FROM memories m
         JOIN sessions s ON s.id = m.source_session_id
         ORDER BY m.id DESC
         LIMIT 20`,
      )
      .all() as Array<{
      memoryId: number;
      content: string;
      sessionId: number;
      createdAt: number;
      rank: number;
    }>;

    return allRows.map((r) => ({
      memoryId: r.memoryId,
      sessionId: r.sessionId,
      date: new Date(r.createdAt).toISOString().slice(0, 10),
      content: r.content,
      rank: r.rank,
    }));
  }

  const words = keywordsFrom(userMessage);
  if (words.length === 0) return [];

  // Use prefix wildcard matching for root-word / inflection support
  const match = words.map((w) => `"${w}"*`).join(" OR ");
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

/**
 * Smart distillation gate: avoids wasting round-trips and API quota
 * on small talk, trivial one-word replies, or continuity triggers.
 */
export function shouldExtractMemories(userMessage: string): boolean {
  const trimmed = userMessage.trim().toLowerCase().replace(/[.,!?;:]/g, "");
  if (trimmed.length < 15) {
    const trivial = new Set([
      "hi", "hello", "hey", "thanks", "thank you", "ok", "okay",
      "cool", "yes", "no", "yep", "nope", "sure", "bye", "goodbye",
      "let's continue", "lets continue", "continue",
    ]);
    if (trivial.has(trimmed)) return false;
  }
  const words = keywordsFrom(userMessage);
  return words.length >= 2;
}

const EXTRACTION_SYSTEM = `You distill durable long-term memories from one exchange with the user. Reply with ONLY a JSON object — no markdown fences, no text before or after it:
{"memories": ["..."]}
- At most 2 short third-person statements (under 200 characters each) capturing key facts, decisions, preferences, projects, goals, or commitments worth carrying into future conversations.
- Never include small talk, transient states, or speculation.
- If nothing qualifies, return {"memories": []}.`;

/**
 * The extraction call: distills the finished exchange into durable memories
 * and writes them with semantic overlap deduplication.
 */
export async function extractMemories(params: {
  sessionId: number;
  userMessage: string;
  assistantReply: string;
}): Promise<string[]> {
  if (!shouldExtractMemories(params.userMessage)) {
    return [];
  }

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

  const existingRows = sqlite
    .prepare("SELECT content FROM memories ORDER BY id DESC LIMIT 50")
    .all() as Array<{ content: string }>;

  const written: string[] = [];
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

    // Fuzzy deduplication: check if an existing memory shares high keyword overlap
    const newWords = keywordsFrom(content);
    const isRedundant = existingRows.some((ex) => {
      if (ex.content === content) return true;
      const exWords = new Set(keywordsFrom(ex.content));
      if (exWords.size === 0 || newWords.length === 0) return false;
      const overlap = newWords.filter((w) => exWords.has(w)).length;
      return overlap / Math.max(exWords.size, newWords.length) >= 0.75;
    });

    if (isRedundant) continue;

    const info = insertMemory.run(content, params.sessionId, Date.now());
    insertFts.run(Number(info.lastInsertRowid), content);
    written.push(content);
    existingRows.push({ content });
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
