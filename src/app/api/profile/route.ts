import { db } from "@/lib/db";
import { profile } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const rows = db.select().from(profile).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return Response.json({
    onboardingDone: map.get("onboarding_done") === "true",
    getStartedSeen: map.get("get_started_seen") === "true",
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { key, value } = (body ?? {}) as { key?: string; value?: string | boolean };

  if (key) {
    const val = String(value);
    db.insert(profile)
      .values({ key, value: val })
      .onConflictDoUpdate({
        target: profile.key,
        set: { value: val },
      })
      .run();
  }

  const rows = db.select().from(profile).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  return Response.json({
    onboardingDone: map.get("onboarding_done") === "true",
    getStartedSeen: map.get("get_started_seen") === "true",
  });
}
