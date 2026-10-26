import { findPriorDeliverables } from "../src/lib/memory";

function check(name: string, ok: boolean, detail: string = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
}

function run(): void {
  let ok = true;

  // 1. Repeating a prior deliverable request
  const recipeMatch = findPriorDeliverables("Can you give me that tamale recipe from before?");
  ok = check(
    "prior request detected: 'tamale recipe'",
    recipeMatch.length > 0 && recipeMatch.some((p) => p.sessionTitle.includes("tamale")),
    recipeMatch.length > 0 ? `found session #${recipeMatch[0].sessionId}: "${recipeMatch[0].sessionTitle}" (${recipeMatch[0].date})` : "none",
  ) && ok;

  const ur5Match = findPriorDeliverables("What were the steps for the UR5 calibration?");
  ok = check(
    "prior request detected: 'UR5 calibration'",
    ur5Match.length > 0 && ur5Match.some((p) => p.sessionTitle.includes("UR5")),
    ur5Match.length > 0 ? `found session #${ur5Match[0].sessionId}: "${ur5Match[0].sessionTitle}" (${ur5Match[0].date})` : "none",
  ) && ok;

  // 2. Unrelated fresh request triggers no false positives
  const genericMatch = findPriorDeliverables("Could you explain quantum entanglement in simple terms?");
  ok = check(
    "no false positive on unrelated request",
    genericMatch.length === 0,
    `matches count: ${genericMatch.length}`,
  ) && ok;

  console.log(`\nSLICE 8 REPETITION GUARD VERIFICATION: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

run();
