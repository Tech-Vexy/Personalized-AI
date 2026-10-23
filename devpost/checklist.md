---
doc: checklist
status: draft
---

# Build Checklist

Build mode: fast — chosen at first session (learner's agent experience; learner can switch to learn at any time)

## Slices

- [x] **1. The brain answers inside its envelope (NVIDIA NIM risk slice)**
  Becomes usable: A runnable probe script that sends one message to `z-ai/glm-5.3-flash` on NVIDIA NIM and prints a parsed envelope (`answer`, `memory_used`, `sources`), plus the Next.js scaffold. Nothing user-facing yet — the spec's sanctioned exception: a technical layer alone that proves a critical risk and leaves runnable evidence.
  Why now: NIM is the only external service and the one unverified dependency — exact base URL, API key, credits/rate limits, and whether GLM reliably returns the JSON envelope the whole design hangs on. If this fails or must change, better to know before anything is built on it.
  PRD ref: `prd.md > Features and Behavior` (the envelope underlies `prd.md > Memory Recall — unified store, keyword retrieval` and `prd.md > Visible vs. Invisible Memory — the AI's judgment`)
  Spec ref: `spec.md > External Services and Dependencies`, `spec.md > Stack`, `spec.md > File Structure`
  Build: Scaffold Next.js + TypeScript App Router per the spec's file structure; install `better-sqlite3`, `drizzle-orm`, `openai`, `react-markdown`; create `src/lib/llm.ts` as the only module that calls NIM (OpenAI-compatible client, custom baseURL, 60-second timeout, envelope prompt + parse with one repair re-prompt); write `scripts/probe-nim.ts` to send an envelope-prompted call and print the parsed result; verify the current NIM base URL and model listing against the docs; extend `.gitignore` (add `node_modules`, `.next`, `/data/`, preserving the existing learner-profile and `.env*` rules).
  Verify (mechanical): `npx tsx scripts/probe-nim.ts` prints a parsed envelope with non-empty answer, a boolean `memory_used`, and a `sources` array; record the observed latency and the NIM free-credit/rate-limit situation for the demo.
  Learner check: Put your NVIDIA API key in `.env.local` (I'll show you exactly where and how), run the probe with me, and read the answer it prints — confirm the tone reads like a thinking companion and the latency feels acceptable to you.
  Commit: `Scaffold app and prove NIM envelope call`

- [x] **2. You can chat — and the conversation survives a restart**
  Becomes usable: Open the app, type a message, get a markdown reply in the calm Gemini/Claude-like surface; close everything, reopen, and the conversation is still there. No memory intelligence yet — persistence only.
  Why now: First end-to-end usable behavior: UI → route → SQLite → model → render, all in one slice (bootstrapping is done). Persistence is inherent from the first turn, and the early feedback checkpoint right after this slice can still shape how everything later looks and feels.
  PRD ref: `prd.md > The Core Journey` (steps 3, 8), `prd.md > Look and Feel`
  Spec ref: `spec.md > Components > Main chat`, `spec.md > Components > Chat turn route`, `spec.md > Data Model` (sessions, messages), `spec.md > Where It Runs and How Someone Tries It`
  Build: `src/lib/schema.ts` (sessions, messages) and `src/lib/db.ts` (better-sqlite3 + Drizzle, creates `data/memory.db`); `src/app/api/chat/route.ts` running the turn loop without recall: persist user message → prompt from the session's recent messages → envelope → persist answer → return JSON; `ChatView.tsx` + `Message.tsx` with react-markdown and the airy tokens (≈68ch text column, generous line-height, light/dark via `prefers-color-scheme`); `page.tsx` renders the chat directly for now (gating arrives with onboarding in slice 5).
  Verify (mechanical): `npm run dev` starts with no errors; send a message and get a rendered reply; restart the server and confirm the full conversation reloads from `data/memory.db`; no type/lint errors in the touched files.
  Learner check: Have a short conversation, restart the app, confirm it all came back — then say how the look and feel lands against the Gemini/Claude target. This is the early-feedback checkpoint: your reactions here shape the remaining slices.
  Commit: `Chat with persisted sessions`

- [ ] **3. The kernel: it recalls old ground and shows its receipts**
  Becomes usable: Tell it something in one session; in a later session, mention the topic and it answers with that memory — usually silently, sometimes with a collapsible thought-signature panel above the answer naming the source session, what it took, and why now.
  Why now: This is The Unique Kernel — memory with judgment — placed as early as the loop allows. The keyword quality bar is verified here, while the recorded remedy (embeddings via NIM, schema unchanged) is still cheap.
  PRD ref: `prd.md > Memory Recall — unified store, keyword retrieval`, `prd.md > Visible vs. Invisible Memory — the AI's judgment`
  Spec ref: `spec.md > Components > Recall engine`, `spec.md > Components > Thought-signature panel`, `spec.md > Data Model` (memories, memories_fts), `spec.md > Decisions and Open Issues` (quality bar)
  Build: `memories` + `memories_fts` tables in the schema; the memory-extraction call after each turn (distills durable facts into memories, writes the FTS index — an extraction failure never fails the user-facing turn); `src/lib/memory.ts`: FTS5 MATCH from the user's words → bm25 relevance floor → snippets with session provenance injected into the prompt; envelope `sources` rendered by `ThoughtSignature.tsx` only when `memory_used` is true; `scripts/seed.ts` seeding demo sessions/memories for the quality-bar check.
  Verify (mechanical): run `scripts/seed.ts`; with 5+ seeded sessions, a distinctive phrase from an old session surfaces that session's memory among the top FTS hits and unrelated messages trigger no recall (the quality bar, exactly as recorded in the spec); a recall hit renders the panel with the correct session and date.
  Learner check: In a fresh session, mention something from an earlier one — first watch it answer silently, then watch the thought-signature panel appear. Does the "pulling from your Oct 2 session…" moment feel like proof, or clutter?
  Commit: `Add long-term memory recall and thought-signature panels`

- [ ] **4. "Let's continue" picks up the thread**
  Becomes usable: A New session button in the chat header; type "let's continue" in a fresh session and the AI summarizes where the last session left off and proposes the next step, unprompted. On day one with no sessions: a clarifying question, never a fabricated recap.
  Why now: The core loop's opening move and the demo's first "oh, that's cool" beat; it depends on sessions and memories existing, so it lands right after the kernel.
  PRD ref: `prd.md > Session Continuity — "let's continue"`
  Spec ref: `spec.md > Components > Continuity responder`, `spec.md > Components > Main chat` (New session button)
  Build: New session button (creates an empty session row, swaps it in as active); continuity detection in the chat route as a case-insensitive literal match on "let's continue" / "lets continue" / "let us continue" in a fresh session's first user message (no model classification); on match: last session's tail + its memories → recap prompt ("yesterday we looked at…, today…"); empty-store prompt rule that forbids inventing history and forces a clarifying question.
  Verify (mechanical): after a real session, a fresh session + "let's continue" returns an accurate recap referencing that session's content; with an empty store it asks for clarification; case variants ("Lets continue") all trigger; normal first messages do not trigger it.
  Learner check: This is the beat you scoped the whole app around — open a brand-new session, say "let's continue", and judge whether the pickup feels like relief or a parlor trick.
  Commit: `Add session continuity and new-session flow`

- [ ] **5. First launch: Get Started and conversational onboarding**
  Becomes usable: A fresh data file now starts at a Get Started page, flows into an onboarding *conversation* (the AI asks a few facts one at a time, no form UI), and lands in the main chat — which can already reference the seeded facts on its own.
  Why now: Completes the PRD's front door and seeds the store the kernel reads; the last journey piece needed before the navigation and guard polish.
  PRD ref: `prd.md > The Core Journey` (steps 1–2), `prd.md > Onboarding & Memory Seeding`
  Spec ref: `spec.md > Components > Get Started screen`, `spec.md > Components > Onboarding conversation`, `spec.md > Data Model` (profile)
  Build: `GetStarted.tsx` (what the app does, one button onward, no signup/login anywhere); onboarding system prompt inside the normal chat pipeline (one question at a time); the envelope's `onboarding_complete` field flips `profile.onboarding_done` when GLM has enough, and the UI switches to chat; `page.tsx` gating Get Started → Onboarding → ChatView; onboarding answers persist as messages and distill into the first memories like any turn.
  Verify (mechanical): delete `data/memory.db` → fresh flow: Get Started → onboarding asks several single questions → chat; `profile.onboarding_done` is set in the database; a seeded fact resurfaces via recall in a later message; restarting never re-opens onboarding.
  Learner check: Run onboarding yourself on a fresh database — does it feel like conversation rather than a questionnaire, and does the AI correctly use a fact you gave it afterward?
  Commit: `Add Get Started gate and conversational onboarding`

- [ ] **6. History: the second lens on the same store**
  Becomes usable: The hamburger toggles a drawer listing every session with its derived title and date; tapping one reopens it resumable — new messages append to it; a New session action lives at the top of the list.
  Why now: Round-trips the PRD's navigation step and demonstrates that history and recall are two lenses on one SQLite file — no second source of truth.
  PRD ref: `prd.md > History View`
  Spec ref: `spec.md > Components > History drawer`, `spec.md > Data Model` (sessions)
  Build: `src/app/api/sessions/route.ts` (list all sessions; fetch one with its messages); `HistoryDrawer.tsx` toggled from the chat header's hamburger; tapping a session makes it active and loads its messages; auto-derived titles from the first user words (renaming is recorded later polish).
  Verify (mechanical): create 3+ sessions → all listed with correct titles/dates; opening one loads exactly its messages; sending a message while an old session is active appends to that session, not the newest; the drawer and recall read the same database rows.
  Learner check: Flip between old conversations and the current one, continue an old thread, and confirm nothing crosses between sessions.
  Commit: `Add history drawer over sessions`

- [ ] **7. Asked twice? Point back, don't regenerate**
  Becomes usable: Request something you already got — the CV from last week — and the AI retrieves instead of regenerating: it points back to the earlier conversation and what was made there. Unrelated new requests proceed normally.
  Why now: The PRD's repetition-waste insight, kept as its own small slice so the kernel slice stays focused; it completes `memory.ts`'s repertoire exactly as the spec splits it (recall + repetition detection in one module).
  PRD ref: `prd.md > Repetition Guard — retrieval over regeneration`
  Spec ref: `spec.md > Components > Recall engine` (bounded LIKE scan), `spec.md > Components > Chat turn route`
  Build: bounded `LIKE` scan over `messages.content` for distinctive request phrases (PoC-sized, no second FTS table); a system-prompt rule: on a strong match, point back to the original session — its title/date and what was made — instead of regenerating; the pointer surfaces through the same envelope, so it can appear with or without a panel per the AI's judgment.
  Verify (mechanical): in a seeded or live scenario, make a distinctive request in session A; in session B repeat it → the answer references session A rather than regenerating; a fresh unrelated request is answered normally (no false positive).
  Learner check: Ask for the same deliverable twice across sessions and watch it point back. Decide whether retrieval-over-regeneration feels like memory or like being brushed off.
  Commit: `Add repetition guard with retrieval instead of regeneration`

- [ ] **8. Mic, failure modes, and the demo-ready surface**
  Becomes usable: The mic button dictates into the input (editable before sending, Chromium browsers); model/network failures show an error with a retry button that resends the identical pending message; the whole journey looks like the calm, airy spec surface — ready to record.
  Why now: The last bundle of small PRD behaviors plus the visual pass, so the demo records the intended experience rather than a styled-at-the-end retrofit.
  PRD ref: `prd.md > Voice Input`, `prd.md > Failure & Recovery`, `prd.md > Look and Feel`
  Spec ref: `spec.md > Components > Main chat` (mic), `spec.md > Components > Error & retry`, `spec.md > Important Failure Modes`, `spec.md > Look and Feel`
  Build: Web Speech API dictation → editable input text (mic not rendered when the API is absent); 60-second timeouts on every model call → error + retry with the pending message held in client state until answered; malformed-envelope repair re-prompt, then plain-text fallback (never block the user on formatting); airy styling pass over all screens (chat, panels, drawer, Get Started, onboarding) against the spec's tokens.
  Verify (mechanical): run with an invalid `NVIDIA_API_KEY` → the UI shows error + retry, the pending message is preserved, and retry resends the identical text; restore the key and the same message succeeds; mic fills the input in a Chromium browser; `npm run build` passes clean.
  Learner check: Dictate a message, then (with me) break the key to see error + retry recover your message. Then kick the tires across the whole journey — this flows into the final review.
  Commit: `Add mic input, error and retry handling, and visual polish`

## Hands-on Checkpoints

- [ ] Early usable behavior explored — after slice 2 (first real chat + restart): feedback on look/feel and reply quality, while it can still shape slices 3–8
- [ ] Final kick-the-tires exploration and feedback completed — after slice 8: the full core journey, including the three demo beats (clean-slate session that isn't clean, recall that names its source, retrieval instead of regeneration)

## Final Review

- [ ] Final review complete — feedback resolved and learner confirms ready to ship

## Code Tour and App Map

- [ ] Learning activity complete — guided route, focused alternative, prior practice connected, or brief recap
- [ ] Optional edit and transfer reflection addressed — offered/declined/already covered/not applicable as appropriate
- [ ] `devpost/app-map.html` generated from finished code, checked, and shown, including a project-grounded practice to reuse

Activity and evidence: [what actually happened; real document/test/code references; unfinished work if interrupted]
Route and stops: [actual paths and symbols; guided stops completed, or reference-only route]
Edit outcome: [tried/kept/reverted/declined/not applicable; verification if changed]
Reflection: [offered/answered/declined/already covered — personal answer belongs only in the ignored profile]
Activity mode: [live app and editor, explicit static fallback, focused alternative, prior practice, or recap]

## Revisions

- **Slice 1 evidence (2026-10-23):** GLM-5.3-flash verified live on NIM — probe PASS: valid envelope (non-empty markdown answer, `memory_used` boolean, `sources` array), 73.7s latency at `reasoning_effort:"low"` (earlier probes 105–170s), 236 in / 352 out tokens, no rate-limit headers returned. Model listing confirmed against the live catalog. Recorded remedies, applied in `src/lib/llm.ts`: `REQUEST_TIMEOUT_MS` 60s → 180s (GLM's thinking regularly exceeds 60s; the spec's 60s note is superseded), `max_tokens: 2048` (with a small budget GLM's reasoning pass consumed the completion before the envelope was written → `content: null`), `reasoning_effort: "low"` (documented GLM-5.3 knob; default is "max"). Live-catalog drift noted: `llama-3.3-70b-instruct`, `kimi-k2-instruct`, `qwen3-next-80b-a3b-instruct` are EOL (HTTP 410); `kimi-k2.6` is not enabled for this account (404). Learner confirmed keeping GLM-5.3-flash; no model swap.



