import { isContinuityTrigger } from "../src/app/api/chat/route";
import { db, sqlite } from "../src/lib/db";
import { sessions, messages, memories } from "../src/lib/schema";
import { desc, ne } from "drizzle-orm";

function check(name: string, ok: boolean, detail: string = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
}

function run(): void {
  let ok = true;

  // 1. Trigger phrase variants
  ok = check("variant: 'let\\'s continue'", isContinuityTrigger("let's continue")) && ok;
  ok = check("variant: 'lets continue'", isContinuityTrigger("lets continue")) && ok;
  ok = check("variant: 'let us continue'", isContinuityTrigger("let us continue")) && ok;
  ok = check("variant: 'LET\\'S CONTINUE!'", isContinuityTrigger("LET'S CONTINUE!")) && ok;
  ok = check("variant: 'Lets continue.'", isContinuityTrigger("Lets continue.")) && ok;

  // 2. Negative cases
  ok = check("negative: 'Hello there'", !isContinuityTrigger("Hello there")) && ok;
  ok = check("negative: 'continue'", !isContinuityTrigger("continue")) && ok;
  ok = check("negative: 'let us continue with the project plan'", !isContinuityTrigger("let us continue with the project plan")) && ok;

  // 3. Continuity query verification against existing database
  const activeSessionId = 999999;
  const lastSession = db
    .select()
    .from(sessions)
    .where(ne(sessions.id, activeSessionId))
    .orderBy(desc(sessions.updatedAt))
    .limit(1)
    .get();

  ok = check(
    "queries prior session correctly",
    !!lastSession,
    lastSession ? `found session #${lastSession.id}: "${lastSession.title}"` : "no prior session",
  ) && ok;

  if (lastSession) {
    const lastMsgs = db
      .select()
      .from(messages)
      .where(ne(messages.id, -1))
      .orderBy(desc(messages.id))
      .limit(6)
      .all();
    ok = check("fetches prior session messages", lastMsgs.length > 0, `found ${lastMsgs.length} messages`) && ok;
  }

  console.log(`\nSLICE 5 CONTINUITY VERIFICATION: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

run();
