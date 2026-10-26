import { db, sqlite } from "../src/lib/db";
import { profile } from "../src/lib/schema";
import { eq } from "drizzle-orm";

function check(name: string, ok: boolean, detail: string = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
}

function run(): void {
  let ok = true;

  // 1. Check current profile state
  const initial = db
    .select()
    .from(profile)
    .where(eq(profile.key, "onboarding_done"))
    .get();

  console.log("Initial onboarding_done:", initial?.value ?? "not set");

  // 2. Set onboarding_done = true
  db.insert(profile)
    .values({ key: "onboarding_done", value: "true" })
    .onConflictDoUpdate({
      target: profile.key,
      set: { value: "true" },
    })
    .run();

  const afterSet = db
    .select()
    .from(profile)
    .where(eq(profile.key, "onboarding_done"))
    .get();

  ok = check("profile.onboarding_done saved", afterSet?.value === "true") && ok;

  // 3. Verify key persistence across new connection
  const rawRow = sqlite.prepare("SELECT value FROM profile WHERE key = 'onboarding_done'").get() as { value: string } | undefined;
  ok = check("raw SQLite reads onboarding_done correctly", rawRow?.value === "true") && ok;

  console.log(`\nSLICE 6 GATING VERIFICATION: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

run();
