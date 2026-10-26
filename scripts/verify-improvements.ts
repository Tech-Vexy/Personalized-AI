import { keywordsFrom, recallMemories, shouldExtractMemories } from "../src/lib/memory";

function check(name: string, ok: boolean, detail: string = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
}

function run(): void {
  let ok = true;

  // 1. Gating check
  ok = check("gating: 'hi' is skipped", !shouldExtractMemories("hi")) && ok;
  ok = check("gating: 'thanks' is skipped", !shouldExtractMemories("thanks")) && ok;
  ok = check("gating: 'let\\'s continue' is skipped", !shouldExtractMemories("let's continue")) && ok;
  ok = check("gating: 'ok cool' is skipped", !shouldExtractMemories("ok cool")) && ok;
  ok = check(
    "gating: substantive message accepted",
    shouldExtractMemories("I am planning to install 500 solar panels in Nevada next spring."),
  ) && ok;

  // 2. Wildcard prefix check in recallMemories
  const financialMemories = recallMemories("What did we say about financ?", -1);
  ok = check(
    "prefix wildcard: 'financ?' matches finance/financial memories",
    financialMemories.length > 0,
    `found ${financialMemories.length} memories`,
  ) && ok;

  console.log(`\nIMPROVEMENTS MECHANICAL VERIFICATION: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

run();
