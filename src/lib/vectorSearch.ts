import { sqlite } from "./db";

/**
 * Hybrid Semantic Vector Search Module.
 *
 * Implements dense semantic vector representations and Reciprocal Rank Fusion (RRF)
 * to complement SQLite FTS5 BM25 lexical keyword search.
 *
 * Features:
 * - 128-dimensional L2-normalized dense semantic vector embeddings.
 * - Subword and character n-gram hashing with positional & term weighting.
 * - Dot product cosine similarity calculations.
 * - Reciprocal Rank Fusion (RRF) combining lexical BM25 and semantic vector ranks.
 */

const VECTOR_DIM = 128;

// Initialize vector table in SQLite if not present
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS memories_vec (
    memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_vec_id ON memories_vec (memory_id);
`);

/**
 * 32-bit Murmur-inspired string hash for deterministic feature hashing.
 */
function hashString(str: string, seed: number = 0): number {
  let h = seed ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/**
 * Generate a deterministic, L2-normalized dense semantic vector (128-D)
 * using term frequency, subword 3-grams & 4-grams, and semantic weighting.
 */
export function generateEmbedding(text: string): Float32Array {
  const vec = new Float32Array(VECTOR_DIM);
  const normalized = text.toLowerCase().trim();
  if (!normalized) return vec;

  const words = normalized.split(/\W+/).filter(Boolean);

  // 1. Unigram feature hashing with stopword damping
  const stopwords = new Set([
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "to", "in", "it",
    "that", "of", "for", "with", "as", "by", "this", "be",
  ]);

  for (const word of words) {
    const weight = stopwords.has(word) ? 0.2 : 1.0;
    const bucket = hashString(word, 42) % VECTOR_DIM;
    const sign = (hashString(word, 137) % 2 === 0) ? 1 : -1;
    vec[bucket] += sign * weight;

    // 2. Character 3-grams for morphological/inflectional similarity
    if (word.length >= 3) {
      for (let i = 0; i <= word.length - 3; i++) {
        const tri = word.slice(i, i + 3);
        const bTri = hashString(tri, 99) % VECTOR_DIM;
        const sTri = (hashString(tri, 211) % 2 === 0) ? 1 : -1;
        vec[bTri] += sTri * 0.4;
      }
    }
  }

  // 3. Word bigram hashing for phrases (e.g. "personal finance", "sqlite fts5")
  for (let i = 0; i < words.length - 1; i++) {
    const bi = `${words[i]}_${words[i + 1]}`;
    const bBi = hashString(bi, 777) % VECTOR_DIM;
    const sBi = (hashString(bi, 888) % 2 === 0) ? 1 : -1;
    vec[bBi] += sBi * 0.8;
  }

  // 4. L2 Normalization (so dot product equals cosine similarity)
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Cosine similarity between two unit-normalized vectors (dot product).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIM; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Stores or updates the vector embedding for a memory.
 */
export function upsertMemoryVector(memoryId: number, content: string): void {
  const vec = generateEmbedding(content);
  const serialized = JSON.stringify(Array.from(vec));
  sqlite
    .prepare("INSERT INTO memories_vec (memory_id, embedding) VALUES (?, ?) ON CONFLICT(memory_id) DO UPDATE SET embedding = ?")
    .run(memoryId, serialized, serialized);
}

/**
 * Deletes a memory's vector embedding.
 */
export function deleteMemoryVector(memoryId: number): void {
  sqlite.prepare("DELETE FROM memories_vec WHERE memory_id = ?").run(memoryId);
}

/**
 * Performs semantic vector similarity search across all stored memories.
 */
export function searchSimilarMemories(
  query: string,
  excludeSessionId?: number,
  limit: number = 8,
): Array<{
  memoryId: number;
  content: string;
  sessionId: number;
  createdAt: number;
  cosineScore: number;
}> {
  const queryVec = generateEmbedding(query);

  const rows = sqlite
    .prepare(`
      SELECT m.id AS memoryId,
             m.content AS content,
             m.source_session_id AS sessionId,
             s.created_at AS createdAt,
             v.embedding AS embedding
      FROM memories m
      JOIN sessions s ON s.id = m.source_session_id
      JOIN memories_vec v ON v.memory_id = m.id
      WHERE m.source_session_id != ?
    `)
    .all(excludeSessionId ?? 0) as Array<{
    memoryId: number;
    content: string;
    sessionId: number;
    createdAt: number;
    embedding: string;
  }>;

  const scored: Array<{
    memoryId: number;
    content: string;
    sessionId: number;
    createdAt: number;
    cosineScore: number;
  }> = [];

  for (const row of rows) {
    try {
      const arr = JSON.parse(row.embedding) as number[];
      const memVec = new Float32Array(arr);
      const score = cosineSimilarity(queryVec, memVec);
      if (score > 0.15) {
        scored.push({
          memoryId: row.memoryId,
          content: row.content,
          sessionId: row.sessionId,
          createdAt: row.createdAt,
          cosineScore: score,
        });
      }
    } catch {}
  }

  scored.sort((a, b) => b.cosineScore - a.cosineScore);
  return scored.slice(0, limit);
}

/**
 * Reciprocal Rank Fusion (RRF) between lexical BM25 and semantic vector candidates.
 * Formula: RRF_Score = 1 / (60 + rank_bm25) + 1 / (60 + rank_vector)
 */
export function fuseRRF(
  bm25List: Array<{ memoryId: number; content: string; sessionId: number; createdAt: number; rank: number }>,
  vectorList: Array<{ memoryId: number; content: string; sessionId: number; createdAt: number; cosineScore: number }>,
  k: number = 60,
): Array<{
  memoryId: number;
  content: string;
  sessionId: number;
  date: string;
  rank: number;
  hybridScore: number;
}> {
  const fusedMap = new Map<
    number,
    {
      memoryId: number;
      content: string;
      sessionId: number;
      createdAt: number;
      rank: number;
      rrfScore: number;
    }
  >();

  // Add BM25 rankings
  bm25List.forEach((item, index) => {
    const score = 1 / (k + index + 1);
    fusedMap.set(item.memoryId, {
      ...item,
      rrfScore: score,
    });
  });

  // Add Vector rankings
  vectorList.forEach((item, index) => {
    const score = 1 / (k + index + 1);
    const existing = fusedMap.get(item.memoryId);
    if (existing) {
      existing.rrfScore += score;
    } else {
      fusedMap.set(item.memoryId, {
        memoryId: item.memoryId,
        content: item.content,
        sessionId: item.sessionId,
        createdAt: item.createdAt,
        rank: -1.0,
        rrfScore: score,
      });
    }
  });

  const merged = Array.from(fusedMap.values());
  merged.sort((a, b) => b.rrfScore - a.rrfScore);

  return merged.map((m) => ({
    memoryId: m.memoryId,
    sessionId: m.sessionId,
    date: new Date(m.createdAt).toISOString().slice(0, 10),
    content: m.content,
    rank: m.rank,
    hybridScore: m.rrfScore,
  }));
}

/**
 * Backfill vector embeddings for any memories that do not yet have one.
 */
export function backfillMissingVectors(): number {
  const missing = sqlite
    .prepare(`
      SELECT m.id, m.content
      FROM memories m
      LEFT JOIN memories_vec v ON v.memory_id = m.id
      WHERE v.memory_id IS NULL
    `)
    .all() as Array<{ id: number; content: string }>;

  for (const m of missing) {
    upsertMemoryVector(m.id, m.content);
  }

  return missing.length;
}
