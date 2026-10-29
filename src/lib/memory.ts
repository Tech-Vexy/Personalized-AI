import { sqlite } from "./db";
import { callModel } from "./llm";
import {
  upsertMemoryVector,
  deleteMemoryVector,
  searchSimilarMemories,
  fuseRRF,
} from "./vectorSearch";

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

/**
 * Fetches the most foundational ambient memories about the user
 * (identity, primary projects, preferences) so the AI never acts like a stranger.
 */
export function getCoreMemories(
  excludeSessionId?: number,
  limit: number = 6,
): RecalledMemory[] {
  const rows = sqlite
    .prepare(
      `SELECT m.id          AS memoryId,
              m.content     AS content,
              m.source_session_id AS sessionId,
              s.created_at  AS createdAt
       FROM memories m
       JOIN sessions s ON s.id = m.source_session_id
       WHERE (? IS NULL OR m.source_session_id != ?)
       ORDER BY m.id DESC
       LIMIT ?`,
    )
    .all(excludeSessionId ?? null, excludeSessionId ?? null, limit) as Array<{
    memoryId: number;
    content: string;
    sessionId: number;
    createdAt: number;
  }>;

  return rows.map((r) => ({
    memoryId: r.memoryId,
    sessionId: r.sessionId,
    date: new Date(r.createdAt).toISOString().slice(0, 10),
    content: r.content,
    rank: -1.0,
  }));
}

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
 * Detects if the user's message is an explicit instruction to forget or delete
 * a topic or memory (e.g. "Forget about the Kyoto trip", "Please delete my tamale recipe").
 */
export function detectForgetDirective(text: string): string | null {
  const norm = text.trim();
  const patterns = [
    /^(?:please\s+)?forget\s+(?:about\s+)?(?:all\s+(?:about\s+)?)?(.+)/i,
    /^(?:please\s+)?(?:delete|remove)\s+(.+?)\s+(?:from\s+(?:your\s+|my\s+)?memory|from\s+vault)/i,
    /^(?:please\s+)?don'?t\s+remember\s+(?:about\s+)?(.+)/i,
    /^(?:please\s+)?erase\s+(.+?)\s+from\s+memory/i,
  ];
  for (const p of patterns) {
    const match = norm.match(p);
    if (match && match[1]) {
      const topic = match[1].trim().replace(/[.,!?;:]+$/, "");
      if (topic.length >= 2) return topic;
    }
  }
  return null;
}

/**
 * Eradicates all memories matching the specified topic from both relational table and FTS index.
 */
export function forgetMemoriesMatching(topic: string): {
  forgottenCount: number;
  contents: string[];
} {
  const words = keywordsFrom(topic);
  if (words.length === 0) return { forgottenCount: 0, contents: [] };

  const match = words.map((w) => `"${w}"*`).join(" OR ");
  const rows = sqlite
    .prepare(
      `SELECT m.id, m.content
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ?`,
    )
    .all(match) as Array<{ id: number; content: string }>;

  if (rows.length === 0) return { forgottenCount: 0, contents: [] };

  const deleteFts = sqlite.prepare("DELETE FROM memories_fts WHERE rowid = ?");
  const deleteMem = sqlite.prepare("DELETE FROM memories WHERE id = ?");

  const contents: string[] = [];
  for (const r of rows) {
    deleteFts.run(r.id);
    deleteMem.run(r.id);
    deleteMemoryVector(r.id);
    contents.push(r.content);
  }

  return { forgottenCount: rows.length, contents };
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

  // 1. Lexical BM25 search over FTS5 (if keywords exist)
  let bm25Rows: Array<{
    memoryId: number;
    content: string;
    sessionId: number;
    createdAt: number;
    rank: number;
  }> = [];

  if (words.length > 0) {
    const match = words.map((w) => `"${w}"*`).join(" OR ");
    try {
      bm25Rows = sqlite
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
        .all(match) as typeof bm25Rows;
    } catch {}
  }

  const bm25Matches = bm25Rows.filter(
    (r) => r.rank <= BM25_FLOOR && r.sessionId !== excludeSessionId,
  );

  // 2. Dense Semantic Vector Similarity Search
  const vectorMatches = searchSimilarMemories(userMessage, excludeSessionId, 8);

  // 3. Reciprocal Rank Fusion (Hybrid search combination)
  const fused = fuseRRF(bm25Matches, vectorMatches);
  return fused.slice(0, 6);
}

/**
 * Smart distillation gate: avoids wasting round-trips and API quota
 * on small talk, trivial one-word replies, continuity triggers, or meta-memory queries.
 */
export function shouldExtractMemories(userMessage: string): boolean {
  if (isMetaMemoryQuery(userMessage) || detectForgetDirective(userMessage)) {
    return false;
  }

  const trimmed = userMessage.trim().toLowerCase().replace(/[.,!?;:]/g, "");
  const trivial = new Set([
    "hi", "hello", "hey", "thanks", "thank you", "ok", "okay",
    "cool", "yes", "no", "yep", "nope", "sure", "bye", "goodbye",
    "let's continue", "lets continue", "continue", "whats up", "what's up",
    "good morning", "good evening", "how are you", "who are you",
  ]);
  if (trivial.has(trimmed)) return false;

  const words = keywordsFrom(userMessage);
  return words.length >= 2;
}

const EXTRACTION_SYSTEM = `You are the memory distillation kernel for a personal AI companion where long-term memory is the central commodity.
Your sole job is to distill durable, long-term knowledge about the USER from the exchange.

WHAT CAN BE REMEMBERED (Durable facts about the USER):
- User Identity & Background: Name, profession, location, expertise, affiliations.
- Projects & Systems: Products they are building, codebases, architectural decisions, technical choices.
- Visual Artifacts & Designs: When analyzing user-provided images, diagrams, mockups, or screenshots, capture what the user's diagram, architecture, or design portrays (e.g. "User's system diagram uses SQLite with FTS5 and an embedded replica").
- Durable Preferences & Working Style: Tone preferences, how they like answers structured, persistent technical biases.
- Life Facts & Constraints: Milestones, recurring commitments, plans, constraints, deadlines.
- Explicit Directives: Anything the user explicitly asked to remember ("Remember that...", "Note down that...").

WHAT MUST NEVER BE REMEMBERED (Strict Negative Constraints):
- NEVER distill facts about the AI (e.g. NEVER "The AI is a thinking companion", NEVER "The assistant explained X").
- NEVER distill conversational actions (e.g. NEVER "User greeted the assistant", NEVER "User asked a question").
- NEVER distill transient session states (e.g. "User is currently testing", "Discussion is focused on X").
- NEVER distill non-facts (e.g. "User's preference is undetermined").
- NEVER distill small talk, trivia, or general code syntax.

WHEN TO REMEMBER:
- Only when the exchange revealed a genuine, durable truth about the user that will remain valuable weeks or months from now.
- If nothing qualifies, return {"memories": []}.

FORMAT:
Reply with ONLY a JSON object — no markdown fences, no text before or after it:
{"memories": ["Third-person statement about the user under 180 chars...", ...]}
At most 2 concise statements per exchange.`;

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
    .prepare("SELECT id, content FROM memories ORDER BY id DESC LIMIT 50")
    .all() as Array<{ id: number; content: string }>;

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

    // Fuzzy deduplication & state superseding
    const newWords = keywordsFrom(content);
    let isRedundant = false;
    let supersededId: number | null = null;

    for (const ex of existingRows) {
      if (ex.content === content) {
        isRedundant = true;
        break;
      }
      const exWords = new Set(keywordsFrom(ex.content));
      if (exWords.size === 0 || newWords.length === 0) continue;
      const overlap = newWords.filter((w) => exWords.has(w)).length;
      const similarity = overlap / Math.max(exWords.size, newWords.length);

      if (similarity >= 0.82) {
        isRedundant = true;
        break;
      } else if (similarity >= 0.55) {
        // High topic overlap with updated state — supersede old stale memory
        supersededId = ex.id;
        break;
      }
    }

    if (isRedundant) continue;

    // Eradicate outdated stale record from store, search index, and vector index
    if (supersededId) {
      sqlite.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(supersededId);
      sqlite.prepare("DELETE FROM memories WHERE id = ?").run(supersededId);
      deleteMemoryVector(supersededId);
    }

    const info = insertMemory.run(content, params.sessionId, Date.now());
    const newId = Number(info.lastInsertRowid);
    insertFts.run(newId, content);
    upsertMemoryVector(newId, content);
    written.push(content);
    existingRows.push({ id: newId, content });
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
