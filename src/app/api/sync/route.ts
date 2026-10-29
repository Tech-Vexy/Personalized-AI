import {
  getSyncStatus,
  syncWithTurso,
  exportDatabaseSnapshot,
  importDatabaseSnapshot,
} from "@/lib/tursoSync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sync
 * - Default: returns Turso cloud sync status & local table counts.
 * - ?export=true: downloads complete portable database snapshot (JSON).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const isExport = url.searchParams.get("export") === "true";

  if (isExport) {
    const snapshot = exportDatabaseSnapshot();
    const filename = `personal-ai-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify(snapshot, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const status = getSyncStatus();
  return Response.json(status);
}

/**
 * POST /api/sync
 * - { action: "sync" }: triggers bidirectional sync with Turso cloud.
 * - { action: "import", snapshot: {...} }: restores database from snapshot.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { action, snapshot } = (body ?? {}) as {
    action?: string;
    snapshot?: Parameters<typeof importDatabaseSnapshot>[0];
  };

  if (action === "import") {
    if (!snapshot || typeof snapshot !== "object") {
      return Response.json({ error: "Invalid snapshot data for import" }, { status: 400 });
    }
    const result = importDatabaseSnapshot(snapshot);
    return Response.json({ success: true, ...result });
  }

  // Default: execute cloud sync
  const result = await syncWithTurso();
  const status = getSyncStatus();

  return Response.json({
    ...result,
    currentStatus: status,
  });
}
