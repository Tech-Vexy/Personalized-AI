/**
 * Slice 4 quality-bar seed (devpost/checklist.md > slice 4):
 * seeds 6 distinctive demo sessions with memories, then runs the recorded
 * quality bar — a distinctive phrase from an old session surfaces that
 * session's memory among the top FTS hits, and unrelated messages trigger
 * no recall (spec.md > Decisions and Open Issues).
 * Run: npx tsx scripts/seed.ts
 */
import { sqlite } from "../src/lib/db";
import { recallMemories, keywordsFrom, BM25_FLOOR } from "../src/lib/memory";

const DAY = 24 * 60 * 60 * 1000;

type Seed = {
  daysAgo: number;
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  memories: string[];
};

const SEEDS: Seed[] = [
  {
    daysAgo: 14,
    title: "Lumen wallet redesign",
    messages: [
      { role: "user", content: "I started redesigning my personal finance app, Lumen. I think a card-based dashboard beats the ledger list I had." },
      { role: "assistant", content: "Cards give each account a glanceable home. What did the ledger list do poorly?" },
      { role: "user", content: "It buried trends. I also want a weekly digest email instead of push notifications." },
    ],
    memories: [
      "User is redesigning their personal finance app called Lumen; decided on a card-based dashboard and a weekly digest email instead of push notifications.",
    ],
  },
  {
    daysAgo: 12,
    title: "Grandmother's tamales",
    messages: [
      { role: "user", content: "My grandmother's tamale recipe wraps them in banana leaves, not corn husks. I want to document it properly this December." },
      { role: "assistant", content: "Banana leaves give that distinctive floral aroma. A documented family recipe is worth doing carefully — what's the filling?" },
      { role: "user", content: "Slow-roasted pork with achiote. She never wrote anything down, so it's all from watching her." },
    ],
    memories: [
      "User's grandmother's tamale recipe uses banana leaves instead of corn husks, with slow-roasted pork and achiote; user wants to document it in December since it was never written down.",
    ],
  },
  {
    daysAgo: 9,
    title: "Kyoto in blossom season",
    messages: [
      { role: "user", content: "Planning the Kyoto trip for late March, cherry blossom season. I'd rather stay in a ryokan than a hotel." },
      { role: "assistant", content: "A ryokan near the Philosopher's Path puts you minutes from the best hanami walks. Consider a day trip to Nara for the deer and Tōdai-ji." },
      { role: "user", content: "Nara was already on my list. Budget is the constraint — flights booked, lodging not." },
    ],
    memories: [
      "User is planning a cherry-blossom trip to Kyoto in late March; prefers ryokans over hotels, wants a Nara day trip, flights booked but lodging not yet.",
    ],
  },
  {
    daysAgo: 7,
    title: "UR5 calibration saga",
    messages: [
      { role: "user", content: "The UR5 robot arm keeps missing its pick points. Calibration says the tool flange might be bent." },
      { role: "assistant", content: "A bent flange shifts the TCP offset in one axis only — that matches a consistent lateral miss. Measure the flange runout before re-zeroing." },
      { role: "user", content: "Runout confirmed 0.8mm. Lab demo is next Friday, so the timeline is tight." },
    ],
    memories: [
      "User is calibrating a UR5 robot arm for a lab pick-and-place demo; a persistent miss was traced to a 0.8mm tool flange runout, demo deadline Friday.",
    ],
  },
  {
    daysAgo: 4,
    title: "Funes and forgetting",
    messages: [
      { role: "user", content: "My essay compares Borges' Funes the Memorious to AI memory design. My thesis: forgetting is a feature, not a bug." },
      { role: "assistant", content: "Funes drowning in unfiltered detail is exactly the failure mode of naive long-term context. Structure the argument around what he could NOT do — abstract." },
      { role: "user", content: "That's the second section. The third brings in the chatbot that remembers everything about its user and becomes unusable." },
    ],
    memories: [
      "User is writing an essay comparing Borges' 'Funes the Memorious' to AI memory design; thesis is that forgetting is a feature, third section covers chatbots that remember everything.",
    ],
  },
  {
    daysAgo: 2,
    title: "Lease renewal",
    messages: [
      { role: "user", content: "My landlord opened lease renewal at +12%. I pulled comps for three nearby units and asked for a reduction." },
      { role: "assistant", content: "Comps plus a clean payment history is a strong position. Ask for the reduction in writing with a proposed signature date." },
      { role: "user", content: "Settled at +4% — half the increase, gone. Renewal is signed, lease runs through June." },
    ],
    memories: [
      "User negotiated their apartment lease renewal from +12% down to +4% using comparable listings; the lease is signed and runs through June.",
    ],
  },
];

function seed(): void {
  const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  if (count > 0) {
    console.log(`memories table already has ${count} row(s) — refusing to double-seed.`);
    console.log("Delete data/memory.db first if you want a fresh seed.");
    process.exit(0);
  }

  const insertSession = sqlite.prepare(
    "INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)",
  );
  const insertMessage = sqlite.prepare(
    "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertMemory = sqlite.prepare(
    "INSERT INTO memories (content, source_session_id, created_at) VALUES (?, ?, ?)",
  );
  const insertFts = sqlite.prepare(
    "INSERT INTO memories_fts (rowid, content) VALUES (?, ?)",
  );

  const seedAll = sqlite.transaction(() => {
    const now = Date.now();
    for (const s of SEEDS) {
      const at = now - s.daysAgo * DAY;
      const session = insertSession.run(s.title, at, at + 30 * 60 * 1000);
      const sessionId = Number(session.lastInsertRowid);
      s.messages.forEach((m, i) => {
        insertMessage.run(sessionId, m.role, m.content, at + (i + 1) * 60_000);
      });
      for (const mem of s.memories) {
        const row = insertMemory.run(mem, sessionId, at + 40 * 60 * 1000);
        insertFts.run(Number(row.lastInsertRowid), mem);
      }
    }
  });
  seedAll();
  console.log(`Seeded ${SEEDS.length} sessions with ${SEEDS.reduce((n, s) => n + s.memories.length, 0)} memories.\n`);
}

function check(name: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
  return ok;
}

function hitsDetail(hits: ReturnType<typeof recallMemories>): string {
  return hits.map((r) => `#${r.sessionId} rank=${r.rank.toFixed(2)}`).join(", ") || "none";
}

function qualityBar(): boolean {
  let ok = true;

  // 1. Distinctive phrases from old sessions surface those sessions' memories.
  const lumen = recallMemories("How is the Lumen wallet redesign coming along?");
  ok = check(
    "distinctive phrase → Lumen session surfaces",
    lumen.some((r) => r.content.includes("Lumen")),
    `hits: ${hitsDetail(lumen)}`,
  ) && ok;

  const ur5 = recallMemories("remind me — how did the UR5 robot arm calibration end?");
  ok = check(
    "distinctive phrase → UR5 session surfaces",
    ur5.some((r) => r.content.includes("UR5")),
    `hits: ${hitsDetail(ur5)}`,
  ) && ok;

  const tamale = recallMemories("what was that tamale recipe detail again?");
  ok = check(
    "distinctive phrase → tamale session surfaces",
    tamale.some((r) => r.content.includes("tamale")),
    `hits: ${hitsDetail(tamale)}`,
  ) && ok;

  // 2. Unrelated, generic messages trigger NO recall (no false positives).
  for (const q of ["Hi! What's up?", "Can you help me write something?", "Thanks, that's all for today."]) {
    const hits = recallMemories(q);
    ok = check(
      `no false positive → "${q}"`,
      hits.length === 0,
      hits.length
        ? `unexpected hits: ${hits.map((r) => `#${r.sessionId} ${r.content.slice(0, 50)}`).join("; ")}`
        : `keywords: [${keywordsFrom(q).join(", ")}]`,
    ) && ok;
  }

  console.log(`\nrelevance floor: bm25 <= ${BM25_FLOOR} (tune in src/lib/memory.ts if a check fails)`);
  return ok;
}

seed();
const ok = qualityBar();
console.log(`\n${ok ? "QUALITY BAR: PASS" : "QUALITY BAR: FAIL"}`);
process.exit(ok ? 0 : 1);