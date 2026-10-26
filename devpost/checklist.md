---
doc: checklist
status: approved
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

- [x] **3. Swap the brain to Gemini 3.8 Flash and make the app stateless (learner decisions, 2026-10-23)**
  Becomes usable: The app talks to `gemini-3.8-flash` on Google AI through its OpenAI-compatible endpoint, and every launch opens a clean conversation — nothing restored on screen. The store keeps everything for the kernel; the AI is the stateful part, the app is not.
  Why now: Two learner product calls reshape the surface every later slice builds on: GLM's 44–170s silent waits read as "the AI never responds" (both replies did land — the store proves it), and history/session chrome is moving out of the app into the kernel. Cheaper to land before the kernel than after.
  PRD ref: `prd.md > Product Decisions` (app stateless / AI stateful; model swap), `prd.md > The Core Journey` step 7
  Spec ref: `spec.md > Stack`, `spec.md > External Services and Dependencies`, `spec.md > Components > Main chat`
  Build: `src/lib/llm.ts` → base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, key `GOOGLE_API_KEY`, model `gemini-3.8-flash` (env-overridable via `GEMINI_MODEL`); thinking controlled (verify `reasoning_effort:"low"` against the live API; keep a generous `max_tokens` — thinking counts against it); timeout re-baselined from measured latency; `.env.example` rewritten for Google AI; probe renamed `scripts/probe-llm.ts` (package.json `probe` script follows); `ChatView.tsx` drops the reopen-latest-session effect — stateless: an empty conversation on every launch — with empty-state copy saying the surface starts clean while the AI keeps what it knows; `/api/sessions` stays server-side (continuity + provenance read it).
  Verify (mechanical): with `GOOGLE_API_KEY` in `.env.local`, `npm run probe` prints a parsed envelope with non-empty answer; record latency and the free-tier RPM/RPD situation; `npm run dev` boots to an empty conversation; typecheck clean.
  Learner check: create a Gemini API key in AI Studio and put it in `.env.local` as `GOOGLE_API_KEY=…`; send one message and feel the reply latency.
  Commit: `Swap NIM GLM for Gemini 3.8 Flash and make the surface stateless`

- [x] **4. The kernel: it recalls old ground and shows its receipts**
  Becomes usable: Tell it something in one session; in a later session, mention the topic and it answers with that memory — usually silently, sometimes with a collapsible thought-signature panel above the answer naming the source session, what it took, and why now.
  Why now: This is The Unique Kernel — memory with judgment — placed as early as the loop allows. The keyword quality bar is verified here, while the recorded remedy (embeddings via NIM, schema unchanged) is still cheap.
  PRD ref: `prd.md > Memory Recall — unified store, keyword retrieval`, `prd.md > Visible vs. Invisible Memory — the AI's judgment`
  Spec ref: `spec.md > Components > Recall engine`, `spec.md > Components > Thought-signature panel`, `spec.md > Data Model` (memories, memories_fts), `spec.md > Decisions and Open Issues` (quality bar)
  Build: `memories` + `memories_fts` tables in the schema; the memory-extraction call after each turn (distills durable facts into memories, writes the FTS index — an extraction failure never fails the user-facing turn); `src/lib/memory.ts`: FTS5 MATCH from the user's words → bm25 relevance floor → snippets with session provenance injected into the prompt; envelope `sources` rendered by `ThoughtSignature.tsx` only when `memory_used` is true; `scripts/seed.ts` seeding demo sessions/memories for the quality-bar check.
  Verify (mechanical): run `scripts/seed.ts`; with 5+ seeded sessions, a distinctive phrase from an old session surfaces that session's memory among the top FTS hits and unrelated messages trigger no recall (the quality bar, exactly as recorded in the spec); a recall hit renders the panel with the correct session and date.
  Learner check: In a fresh session, mention something from an earlier one — first watch it answer silently, then watch the thought-signature panel appear. Does the "pulling from your Oct 2 session…" moment feel like proof, or clutter?
  Commit: `Add long-term memory recall and thought-signature panels`

- [x] **5. "Let's continue" picks up the thread**
  Becomes usable: Type "let's continue" as the first message after reopening the app and the AI summarizes where the last session left off and proposes the next step, unprompted. On day one with no sessions: a clarifying question, never a fabricated recap.
  Why now: The core loop's opening move and the demo's first "oh, that's cool" beat; it depends on sessions and memories existing, so it lands right after the kernel.
  PRD ref: `prd.md > Session Continuity — "let's continue"`
  Spec ref: `spec.md > Components > Continuity responder`
  Build: continuity detection in the chat route as a case-insensitive literal match on "let's continue" / "lets continue" / "let us continue" in a fresh session's first user message — a fresh session is every app launch (the surface is stateless since slice 3), so detection applies to the first message of a visit (no model classification); on match: last session's tail + its memories → recap prompt ("yesterday we looked at…, today…"); empty-store prompt rule that forbids inventing history and forces a clarifying question.
  Verify (mechanical): after a real session, a fresh session + "let's continue" returns an accurate recap referencing that session's content; with an empty store it asks for clarification; case variants ("Lets continue") all trigger; normal first messages do not trigger it.
  Learner check: This is the beat you scoped the whole app around — open a brand-new session, say "let's continue", and judge whether the pickup feels like relief or a parlor trick.
  Commit: `Add session continuity and new-session flow`

- [x] **6. First launch: Get Started and conversational onboarding**
  Becomes usable: A fresh data file now starts at a Get Started page, flows into an onboarding *conversation* (the AI asks a few facts one at a time, no form UI), and lands in the main chat — which can already reference the seeded facts on its own.
  Why now: Completes the PRD's front door and seeds the store the kernel reads; the last journey piece needed before the navigation and guard polish.
  PRD ref: `prd.md > The Core Journey` (steps 1–2), `prd.md > Onboarding & Memory Seeding`
  Spec ref: `spec.md > Components > Get Started screen`, `spec.md > Components > Onboarding conversation`, `spec.md > Data Model` (profile)
  Build: `GetStarted.tsx` (what the app does, one button onward, no signup/login anywhere); onboarding system prompt inside the normal chat pipeline (one question at a time); the envelope's `onboarding_complete` field flips `profile.onboarding_done` when GLM has enough, and the UI switches to chat; `page.tsx` gating Get Started → Onboarding → ChatView; onboarding answers persist as messages and distill into the first memories like any turn.
  Verify (mechanical): delete `data/memory.db` → fresh flow: Get Started → onboarding asks several single questions → chat; `profile.onboarding_done` is set in the database; a seeded fact resurfaces via recall in a later message; restarting never re-opens onboarding.
  Learner check: Run onboarding yourself on a fresh database — does it feel like conversation rather than a questionnaire, and does the AI correctly use a fact you gave it afterward?
  Commit: `Add Get Started gate and conversational onboarding`

- [x] **7. Mic input and legible waiting**
  Becomes usable: The mic button dictates into the input (editable before sending, Chromium browsers); while the model thinks, the UI shows a clear waiting state with elapsed seconds, so silence never reads as dead. (Replaces the cut history-drawer slice; mic pulled forward at the learner's flag.)
  Why now: The learner flagged the missing mic first, and GLM-era silent waits eroded trust ("the AI never responds" — it was thinking). Both are surface-level and independent of the kernel, so they slot cleanly after it.
  PRD ref: `prd.md > Voice Input`, `prd.md > Look and Feel`
  Spec ref: `spec.md > Components > Main chat` (mic), `spec.md > Components > Error & retry` (waiting state)
  Build: Web Speech API dictation → editable input text (mic not rendered when the API is absent); waiting-state upgrade on the typing indicator: elapsed-seconds hint ("thinking… 12s"), composer disabled while in flight, aria-live announcement; auto-derived session titles stay as-is (renaming remains later polish).
  Verify (mechanical): mic fills the input in a Chromium browser; the waiting state shows elapsed time during a real turn and disappears on reply or error; `/api/sessions` still serves internal reads for continuity/provenance.
  Learner check: dictate a message and watch the waiting state — does the wait feel legible rather than dead?
  Commit: `Add mic input and legible waiting state`

- [ ] **8. Asked twice? Point back, don't regenerate**
  Becomes usable: Request something you already got — the CV from last week — and the AI retrieves instead of regenerating: it points back to the earlier conversation and what was made there. Unrelated new requests proceed normally.
  Why now: The PRD's repetition-waste insight, kept as its own small slice so the kernel slice stays focused; it completes `memory.ts`'s repertoire exactly as the spec splits it (recall + repetition detection in one module).
  PRD ref: `prd.md > Repetition Guard — retrieval over regeneration`
  Spec ref: `spec.md > Components > Recall engine` (bounded LIKE scan), `spec.md > Components > Chat turn route`
  Build: bounded `LIKE` scan over `messages.content` for distinctive request phrases (PoC-sized, no second FTS table); a system-prompt rule: on a strong match, point back to the original session — its title/date and what was made — instead of regenerating; the pointer surfaces through the same envelope, so it can appear with or without a panel per the AI's judgment.
  Verify (mechanical): in a seeded or live scenario, make a distinctive request in session A; in session B repeat it → the answer references session A rather than regenerating; a fresh unrelated request is answered normally (no false positive).
  Learner check: Ask for the same deliverable twice across sessions and watch it point back. Decide whether retrieval-over-regeneration feels like memory or like being brushed off.
  Commit: `Add repetition guard with retrieval instead of regeneration`

- [ ] **9. Failure modes and the demo-ready surface**
  Becomes usable: Model/network failures show an error with a retry button that resends the identical pending message; the whole journey looks like the calm, airy spec surface — ready to record. (Mic moved to slice 7.)
  Why now: The last bundle of small PRD behaviors plus the visual pass, so the demo records the intended experience rather than a styled-at-the-end retrofit.
  PRD ref: `prd.md > Failure & Recovery`, `prd.md > Look and Feel`
  Spec ref: `spec.md > Components > Error & retry`, `spec.md > Important Failure Modes`, `spec.md > Look and Feel`
  Build: 60-second timeouts on every model call → error + retry with the pending message held in client state until answered; malformed-envelope repair re-prompt, then plain-text fallback (never block the user on formatting); airy styling pass over all screens (chat, panels, Get Started, onboarding) against the spec's tokens.
  Verify (mechanical): run with an invalid `GOOGLE_API_KEY` → the UI shows error + retry, the pending message is preserved, and retry resends the identical text; restore the key and the same message succeeds; `npm run build` passes clean.
  Learner check: (With me) break the key to see error + retry recover your message. Then kick the tires across the whole journey — this flows into the final review.
  Commit: `Add error and retry handling, and visual polish`

## Hands-on Checkpoints

- [x] Early usable behavior explored — after slice 2 (first real chat + restart): feedback on look/feel and reply quality, while it can still shape slices 4–9. (Completed 2026-10-23: look/feel approved; mic absence, silent-latency perception, and no-way-to-start-fresh flagged — see Revisions.)
- [ ] Final kick-the-tires exploration and feedback completed — after slice 9: the full core journey, including the three demo beats (clean-slate session that isn't clean, recall that names its source, retrieval instead of regeneration)

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

- **2026-10-26 — model provider decision (NVIDIA NIM):** Learner confirmed using NVIDIA NIM API (`https://integrate.api.nvidia.com/v1`, key `NVIDIA_API_KEY`, default model `z-ai/glm-5.3-flash`, env-overridable via `NIM_MODEL`). Updated `src/lib/llm.ts`, `scripts/probe-llm.ts`, `.env.example`, and `.gitignore`.

- **Slice 4 status (2026-10-23):** Kernel built — `src/lib/memory.ts` (FTS5 recall with bm25 relevance floor −0.6, current session excluded; extraction call writes memories + FTS index, exact-dup guard, fire-and-forget after the reply so it never blocks the turn), recall injection in the chat route, `ThoughtSignature.tsx` panel rendered above the answer only when `memory_used` is true, `scripts/seed.ts` (6 sessions, idempotent). **Quality bar PASS:** Lumen phrase surfaced its session (bm25 −1.36), UR5 (−3.78), tamales (−2.42); three generic messages triggered zero recall. Failed-turn rollback verified clean (no orphan rows). **Outstanding, capacity-blocked:** the one live recall turn that renders the panel — `gemini-3.8-flash` returned sustained HTTP 503/502 "high demand" for ~1 hour (8 attempts across two retry loops; one clear window earlier produced the slice-3 app turn). A 10-attempt retry loop (5-min spacing) is running; when a turn lands, the panel moment doubles as the learner check.

- **Slice 3 evidence (2026-10-23):** `gemini-3.8-flash` verified live — probe PASS: valid envelope (non-empty markdown answer, `memory_used` boolean, `sources` array), 115s latency on the successful call, 234 in / 447 out tokens, no rate-limit headers; app-level turn HTTP 200 in 119.8s with a fresh session created from a stateless client. Intermittent HTTP 503 "high demand" episodes at Google persisted ~20 minutes before clearing — the OpenAI SDK's automatic retries rode through them, and the per-attempt 60s timeout held. Honest latency note: 3.8 currently answers in ~2 minutes under load — comparable to the GLM behavior that motivated the swap; slice 7's legible waiting state is the designed mitigation. During the spike, `gemini-3.6-flash` answered the same envelope in 5–7s; a temporary `GEMINI_MODEL=gemini-3.6-flash` override was set and then **removed at the learner's explicit instruction** — the model is `gemini-3.8-flash` as they chose. `reasoning_effort:"low"` and `max_tokens:2048` verified accepted by the live API (a 300-token probe truncated mid-envelope, confirming thinking tokens count against `max_tokens`).

- **2026-10-23 — early feedback + two learner decisions (replan):** After slice 2 the learner explored the app: look/feel approved ("it looks good"), but flagged (1) no microphone input, (2) "the AI never responds" — diagnosis: both "Hello" messages DID get replies (store rows 3–6); GLM-5.3-flash latency of 44–107s with a silent UI read as dead, and a mid-wait page reload abandons the client fetch while the server still saves the reply, (3) no way to start a fresh conversation because the screen restores the old one. Learner decisions, recorded: **switch the brain to `gemini-3.8-flash` on Google AI** (OpenAI-compatible endpoint verified in docs 2026-10-22; exact model id and base URL `https://generativelanguage.googleapis.com/v1beta/openai/` confirmed); **app stateless, AI stateful** — the user never reviews history or manages sessions ("remember history is all part of memory kernel and not app… they just ask the AI"). Consequences applied to the plan: new slice 3 (provider swap + stateless surface); history-drawer slice cut; mic pulled forward into slice 7 with a legible waiting state; "let's continue" detection re-anchored to the first message after each launch (no New-session button); slices renumbered 1–9. Slice 1–2 records kept as history (NIM-era evidence above).

- **Slice 1 evidence (2026-10-23):** GLM-5.3-flash verified live on NIM — probe PASS: valid envelope (non-empty markdown answer, `memory_used` boolean, `sources` array), 73.7s latency at `reasoning_effort:"low"` (earlier probes 105–170s), 236 in / 352 out tokens, no rate-limit headers returned. Model listing confirmed against the live catalog. Recorded remedies, applied in `src/lib/llm.ts`: `REQUEST_TIMEOUT_MS` 60s → 180s (GLM's thinking regularly exceeds 60s; the spec's 60s note is superseded), `max_tokens: 2048` (with a small budget GLM's reasoning pass consumed the completion before the envelope was written → `content: null`), `reasoning_effort: "low"` (documented GLM-5.3 knob; default is "max"). Live-catalog drift noted: `llama-3.3-70b-instruct`, `kimi-k2-instruct`, `qwen3-next-80b-a3b-instruct` are EOL (HTTP 410); `kimi-k2.6` is not enabled for this account (404). Learner confirmed keeping GLM-5.3-flash; no model swap.



