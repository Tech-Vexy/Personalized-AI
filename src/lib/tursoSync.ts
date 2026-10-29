import { sqlite } from "./db";

/**
 * Turso / LibSQL Cloud Sync Module.
 * 
 * Uses the official LibSQL v2 HTTP Pipeline Protocol over standard fetch:
 * POST https://<db>-<org>.turso.io/v2/pipeline
 * 
 * Zero external npm dependencies required — works seamlessly alongside
 * local better-sqlite3 for ultra-low-latency local-first execution
 * with on-demand or periodic bidirectional cloud synchronization.
 */

export interface TursoConfig {
  url: string;
  authToken: string;
}

export interface SyncStatus {
  configured: boolean;
  dbUrl: string | null;
  lastSyncAt: string | null;
  localCounts: {
    sessions: number;
    messages: number;
    memories: number;
  };
}

export interface SyncResult {
  success: boolean;
  pushed: {
    sessions: number;
    messages: number;
    memories: number;
  };
  pulled: {
    sessions: number;
    messages: number;
    memories: number;
  };
  durationMs: number;
  error?: string;
}

export function getTursoConfig(): TursoConfig | null {
  const rawUrl =
    process.env.TURSO_DATABASE_URL ||
    process.env.TURSO_SYNC_URL ||
    process.env.LIBSQL_URL ||
    process.env.DATABASE_URL ||
    "";
  const authToken =
    process.env.TURSO_AUTH_TOKEN ||
    process.env.TURSO_API_KEY ||
    process.env.LIBSQL_AUTH_TOKEN ||
    "";

  if (!rawUrl || !authToken) return null;

  // Normalize libsql:// to https://
  let normalizedUrl = rawUrl.trim();
  if (normalizedUrl.startsWith("libsql://")) {
    normalizedUrl = normalizedUrl.replace("libsql://", "https://");
  }
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  // Strip trailing slashes
  normalizedUrl = normalizedUrl.replace(/\/+$/, "");

  return { url: normalizedUrl, authToken: authToken.trim() };
}

export function isTursoConfigured(): boolean {
  return getTursoConfig() !== null;
}

/**
 * Execute statements against a remote Turso database using LibSQL HTTP Pipeline API.
 */
async function executeTursoStatements(
  config: TursoConfig,
  statements: Array<{ sql: string; args?: unknown[] }>,
): Promise<Array<Record<string, unknown>>> {
  const endpoint = `${config.url}/v2/pipeline`;

  const requests = statements.map((stmt) => ({
    type: "execute",
    stmt: {
      sql: stmt.sql,
      args: (stmt.args ?? []).map((arg) => {
        if (arg === null || arg === undefined) return { type: "null" };
        if (typeof arg === "number") {
          return Number.isInteger(arg)
            ? { type: "integer", value: String(arg) }
            : { type: "float", value: arg };
        }
        if (typeof arg === "boolean") {
          return { type: "integer", value: arg ? "1" : "0" };
        }
        return { type: "text", value: String(arg) };
      }),
    },
  }));

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (netErr) {
    const msg = netErr instanceof Error ? netErr.message : String(netErr);
    throw new Error(
      `Unable to reach Turso database at ${config.url} (${msg}). Ensure your network environment permits outbound HTTPS to *.turso.io. Local SQLite database remains fully operational.`
    );
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Turso HTTP Error (${res.status} ${res.statusText}): ${errorText}`);
  }

  const data = (await res.json()) as {
    results?: Array<{
      type: string;
      error?: { message: string };
      response?: {
        result?: {
          cols?: Array<{ name: string }>;
          rows?: Array<Array<{ type: string; value?: unknown }>>;
          affected_row_count?: number;
        };
      };
    }>;
  };

  if (!data.results) {
    throw new Error("Invalid Turso response payload");
  }

  const out: Array<Record<string, unknown>> = [];
  for (const item of data.results) {
    if (item.type === "error" && item.error) {
      throw new Error(`Turso query error: ${item.error.message}`);
    }
    const result = item.response?.result;
    if (result && result.cols && result.rows) {
      const colNames = result.cols.map((c) => c.name);
      for (const row of result.rows) {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < colNames.length; i++) {
          const valObj = row[i];
          obj[colNames[i]] = valObj ? valObj.value : null;
        }
        out.push(obj);
      }
    }
  }

  return out;
}

/**
 * Returns current sync metadata & database stats.
 */
export function getSyncStatus(): SyncStatus {
  const config = getTursoConfig();
  const sessionCount = (sqlite.prepare("SELECT count(*) as count FROM sessions").get() as { count: number })?.count ?? 0;
  const messageCount = (sqlite.prepare("SELECT count(*) as count FROM messages").get() as { count: number })?.count ?? 0;
  const memoryCount = (sqlite.prepare("SELECT count(*) as count FROM memories").get() as { count: number })?.count ?? 0;

  const lastSyncRow = sqlite.prepare("SELECT value FROM profile WHERE key = 'last_turso_sync'").get() as { value: string } | undefined;

  return {
    configured: config !== null,
    dbUrl: config ? config.url.replace(/^https?:\/\//, "") : null,
    lastSyncAt: lastSyncRow?.value ?? null,
    localCounts: {
      sessions: sessionCount,
      messages: messageCount,
      memories: memoryCount,
    },
  };
}

/**
 * Bidirectional Synchronization with Turso Cloud.
 * Pushes local records, pulls remote records, and updates sync watermark.
 */
export async function syncWithTurso(): Promise<SyncResult> {
  const started = Date.now();
  const config = getTursoConfig();

  if (!config) {
    return {
      success: false,
      pushed: { sessions: 0, messages: 0, memories: 0 },
      pulled: { sessions: 0, messages: 0, memories: 0 },
      durationMs: 0,
      error: "Turso is not configured. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to .env.local",
    };
  }

  try {
    // 1. Ensure remote DDL exists on Turso
    await executeTursoStatements(config, [
      {
        sql: `CREATE TABLE IF NOT EXISTS sessions (
          id          INTEGER PRIMARY KEY,
          title       TEXT    NOT NULL DEFAULT '',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS messages (
          id          INTEGER PRIMARY KEY,
          session_id  INTEGER NOT NULL,
          role        TEXT    NOT NULL,
          content     TEXT    NOT NULL,
          image_url   TEXT,
          created_at  INTEGER NOT NULL
        );`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS memories (
          id                INTEGER PRIMARY KEY,
          content           TEXT    NOT NULL,
          source_session_id INTEGER NOT NULL,
          created_at        INTEGER NOT NULL
        );`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS profile (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );`,
      },
    ]);

    // 2. Push local records to Turso
    const localSessions = sqlite.prepare("SELECT * FROM sessions").all() as Array<{
      id: number;
      title: string;
      created_at: number;
      updated_at: number;
    }>;
    const localMessages = sqlite.prepare("SELECT * FROM messages").all() as Array<{
      id: number;
      session_id: number;
      role: string;
      content: string;
      image_url: string | null;
      created_at: number;
    }>;
    const localMemories = sqlite.prepare("SELECT * FROM memories").all() as Array<{
      id: number;
      content: string;
      source_session_id: number;
      created_at: number;
    }>;

    const pushStatements: Array<{ sql: string; args: unknown[] }> = [];

    for (const s of localSessions) {
      pushStatements.push({
        sql: "INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        args: [s.id, s.title, s.created_at, s.updated_at],
      });
    }

    for (const m of localMessages) {
      pushStatements.push({
        sql: "INSERT OR REPLACE INTO messages (id, session_id, role, content, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [m.id, m.session_id, m.role, m.content, m.image_url, m.created_at],
      });
    }

    for (const mem of localMemories) {
      pushStatements.push({
        sql: "INSERT OR REPLACE INTO memories (id, content, source_session_id, created_at) VALUES (?, ?, ?, ?)",
        args: [mem.id, mem.content, mem.source_session_id, mem.created_at],
      });
    }

    if (pushStatements.length > 0) {
      // Chunk statements in batches of 50 to avoid request body limits
      for (let i = 0; i < pushStatements.length; i += 50) {
        await executeTursoStatements(config, pushStatements.slice(i, i + 50));
      }
    }

    // 3. Pull remote records from Turso to local SQLite
    const remoteSessions = (await executeTursoStatements(config, [{ sql: "SELECT * FROM sessions" }])) as Array<{
      id: string | number;
      title: string;
      created_at: string | number;
      updated_at: string | number;
    }>;
    const remoteMessages = (await executeTursoStatements(config, [{ sql: "SELECT * FROM messages" }])) as Array<{
      id: string | number;
      session_id: string | number;
      role: string;
      content: string;
      image_url: string | null;
      created_at: string | number;
    }>;
    const remoteMemories = (await executeTursoStatements(config, [{ sql: "SELECT * FROM memories" }])) as Array<{
      id: string | number;
      content: string;
      source_session_id: string | number;
      created_at: string | number;
    }>;

    let pulledSessions = 0;
    let pulledMessages = 0;
    let pulledMemories = 0;

    const insertSession = sqlite.prepare("INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)");
    for (const s of remoteSessions) {
      insertSession.run(Number(s.id), String(s.title || ""), Number(s.created_at), Number(s.updated_at));
      pulledSessions++;
    }

    const insertMsg = sqlite.prepare("INSERT OR REPLACE INTO messages (id, session_id, role, content, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const m of remoteMessages) {
      insertMsg.run(Number(m.id), Number(m.session_id), String(m.role), String(m.content), m.image_url ? String(m.image_url) : null, Number(m.created_at));
      pulledMessages++;
    }

    const insertMem = sqlite.prepare("INSERT OR REPLACE INTO memories (id, content, source_session_id, created_at) VALUES (?, ?, ?, ?)");
    const insertMemFts = sqlite.prepare("INSERT OR REPLACE INTO memories_fts (rowid, content) VALUES (?, ?)");
    for (const mem of remoteMemories) {
      insertMem.run(Number(mem.id), String(mem.content), Number(mem.source_session_id), Number(mem.created_at));
      insertMemFts.run(Number(mem.id), String(mem.content));
      pulledMemories++;
    }

    // 4. Update sync watermark
    const nowIso = new Date().toISOString();
    sqlite.prepare("INSERT INTO profile (key, value) VALUES ('last_turso_sync', ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(nowIso, nowIso);

    return {
      success: true,
      pushed: {
        sessions: localSessions.length,
        messages: localMessages.length,
        memories: localMemories.length,
      },
      pulled: {
        sessions: pulledSessions,
        messages: pulledMessages,
        memories: pulledMemories,
      },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      success: false,
      pushed: { sessions: 0, messages: 0, memories: 0 },
      pulled: { sessions: 0, messages: 0, memories: 0 },
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Portable JSON database export (Full snapshot of sessions, messages, and memories).
 */
export function exportDatabaseSnapshot(): {
  version: string;
  exportedAt: string;
  sessions: unknown[];
  messages: unknown[];
  memories: unknown[];
  profile: unknown[];
} {
  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    sessions: sqlite.prepare("SELECT * FROM sessions ORDER BY id ASC").all(),
    messages: sqlite.prepare("SELECT * FROM messages ORDER BY id ASC").all(),
    memories: sqlite.prepare("SELECT * FROM memories ORDER BY id ASC").all(),
    profile: sqlite.prepare("SELECT * FROM profile ORDER BY key ASC").all(),
  };
}

/**
 * Restores a database snapshot from JSON backup.
 */
export function importDatabaseSnapshot(data: {
  sessions?: Array<{ id: number; title: string; created_at: number; updated_at: number }>;
  messages?: Array<{ id: number; session_id: number; role: string; content: string; image_url?: string; created_at: number }>;
  memories?: Array<{ id: number; content: string; source_session_id: number; created_at: number }>;
}): { imported: { sessions: number; messages: number; memories: number } } {
  let sCount = 0;
  let msgCount = 0;
  let memCount = 0;

  sqlite.transaction(() => {
    if (Array.isArray(data.sessions)) {
      const stmt = sqlite.prepare("INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)");
      for (const s of data.sessions) {
        stmt.run(s.id, s.title, s.created_at, s.updated_at);
        sCount++;
      }
    }

    if (Array.isArray(data.messages)) {
      const stmt = sqlite.prepare("INSERT OR REPLACE INTO messages (id, session_id, role, content, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const m of data.messages) {
        stmt.run(m.id, m.session_id, m.role, m.content, m.image_url ?? null, m.created_at);
        msgCount++;
      }
    }

    if (Array.isArray(data.memories)) {
      const stmt = sqlite.prepare("INSERT OR REPLACE INTO memories (id, content, source_session_id, created_at) VALUES (?, ?, ?, ?)");
      const ftsStmt = sqlite.prepare("INSERT OR REPLACE INTO memories_fts (rowid, content) VALUES (?, ?)");
      for (const mem of data.memories) {
        stmt.run(mem.id, mem.content, mem.source_session_id, mem.created_at);
        ftsStmt.run(mem.id, mem.content);
        memCount++;
      }
    }
  })();

  return { imported: { sessions: sCount, messages: msgCount, memories: memCount } };
}
