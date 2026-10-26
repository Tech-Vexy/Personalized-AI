import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { profile } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const row = db
    .select()
    .from(profile)
    .where(eq(profile.key, "onboarding_done"))
    .get();

  return Response.json({
    onboardingDone: row?.value === "true",
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { done } = (body ?? {}) as { done?: boolean };
  const value = done ? "true" : "false";

  db.insert(profile)
    .values({ key: "onboarding_done", value })
    .onConflictDoUpdate({
      target: profile.key,
      set: { value },
    })
    .run();

  return Response.json({ onboardingDone: done === true });
}
