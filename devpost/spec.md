---
doc: spec
status: approved
---

# Personal AI That Remembers — Technical Spec

## How This Works, In Plain Language

Everything runs on your machine as **one program**: a Next.js app started with `npm run dev` and opened in a browser. It has three parts.

**The interface** is the browser window: the chat, the history drawer behind the hamburger, the mic button that uses your device's built-in speech-to-text, and the collapsible "thought signature" panels that show which past session an answer pulled from. Dark and light both ship; the app follows your device's theme automatically.

**The memory** is a single SQLite file on disk. Every conversation is a session of messages. Alongside them lives the long-term memory: short distilled entries ("user is building X", "user asked for a CV on Oct 2"), each tagged with the session it came from. SQLite's full-text search (FTS5) indexes those entries — that is what makes "older ground resurfaces by keyword" work with no vector database and no second service.

**The brain** is one module that talks to `z-ai/glm-5.3-flash` on NVIDIA NIM, an OpenAI-compatible endpoint. Every turn runs the same loop: your message arrives → keyword search pulls candidate memories → the ones that clear a relevance floor are injected into the prompt → GLM answers in a structured envelope saying *what it answered*, *whether it used memory*, and *which sessions it pulled from* → the exchange is saved, and a small second call distills anything worth keeping into long-term memory. The AI's judgment about showing its work is just a field in that envelope: routine answers say "nothing recalled" and render clean; notable ones carry the panel.

Why this shape: it proves the kernel — unified memory with judgment — with exactly one external service, one process, and one data file. Token streaming, embeddings, and *custom* voice (Cartesia) were deferred deliberately — the built-in mic stays. See *What Was Simplified and Why*.

## The Core Journey Through the System

PRD ref: `prd.md > The Core Journey`.

1. **First launch.** `GetStarted.tsx` shows what the app does; one button flows onward. No auth code exists anywhere.
2. **Onboarding.** The same chat pipeline runs with an onboarding system prompt: GLM asks a few facts one at a time; each answer is saved as a message *and* distilled into the first long-term memories; a `profile.onboarding_done` flag flips when the AI has what it needs.
3. **Main screen.** `ChatView.tsx` + `Message.tsx` render the airy conversation; a **New session** button starts a fresh thread; the mic fills the input with editable text via the Web Speech API; the hamburger toggles `HistoryDrawer.tsx`.
4. **"Let's continue."** On a fresh session, the chat route detects the intent: it fetches the last session's tail and memories, and prompts GLM for "yesterday we looked at…, today…". With no prior sessions, a prompt rule forces a clarifying question — never a fabricated recap.
5. **Talking normally.** Every message triggers recall (FTS5 → relevance floor → prompt injection). When the envelope's `memory_used` is true, `ThoughtSignature.tsx` renders the source panel above the answer; otherwise nothing appears.
6. **Asking twice.** Recall also searches *messages* for prior requests; the system prompt instructs GLM to point back to the original conversation instead of regenerating when a match is strong.
7. **History view.** `/api/sessions` lists all sessions; opening one loads its messages. History and recall read the same SQLite file — two lenses on one store.
8. **Success.** The three demo beats in `prd.md > The Core Journey` step 8 are the build's acceptance test.

## Stack

| Piece | Choice | Why / tradeoff |
|---|---|---|
| Language + framework | **TypeScript + Next.js (App Router)** | Your accepted recommendation: one process, one language, browser-native mic and chat rendering. Tradeoff: TS tooling noise. |
| Database | **SQLite via `better-sqlite3`** | On-device file, zero infrastructure — your lean, confirmed. |
| ORM | **Drizzle ORM** | Typed schema, light, pairs with better-sqlite3; resolves your "ORM depends on framework" note. Derived from the stack choice. |
| Keyword recall | **SQLite FTS5** | Your PRD says keyword-based; FTS5 ships inside SQLite — no extra service. Upgrade path: embeddings, only if the quality bar is missed. |
| LLM | **`z-ai/glm-5.3-flash` on NVIDIA NIM** — `openai` npm SDK with a custom `baseURL` | Your pick, verified in NIM's model list. One module owns every call, so provider swaps stay one-file changes. |
| Markdown rendering | `react-markdown` | Airy long responses per `prd.md > Look and Feel`. |
| Styling | Plain CSS custom properties + `prefers-color-scheme` | Auto dark/light tokens; no CSS framework to fight. |

Unverified — check at build start: NIM free-credit/rate-limit situation and the exact `baseURL` constant in current docs.

## Where It Runs and How Someone Tries It

- **Runtime:** local process, Node 20+. `npm install` → put `NVIDIA_API_KEY=…` in `.env.local` → `npm run dev` → open **http://localhost:3000 in Chrome or Edge** (Web Speech API needs Chromium; other browsers work except dictation).
- **Data:** `data/memory.db` (gitignored). Delete the file to reset to first launch.
- **Demo:** recorded locally; submission = short demo video + public GitHub repository. Deployment optional per scope and **not planned for v1**.
- **Try-it path:** fresh clone → install → key → `npm run dev` → Get Started → onboarding → chat → new session → "let's continue".

## Look and Feel

Carried from `prd.md > Look and Feel` and `scope.md > Inspiration & Identity`: Gemini/Claude-like — calm, refined, generous whitespace; long responses stay airy (text column ~68ch, generous line-height), never ChatGPT-bulky. **Theme follows the device automatically**; both palettes ship as CSS custom-property tokens (light: warm off-white on ink; dark: deep neutral on soft white), with panels and drawer tinted slightly from the surface color. Interface copy: plain, confident, no exclamation marks — a thinking companion, not a flatterer.

## Components

### Get Started screen — `src/components/GetStarted.tsx`
Static intro; one button flows onward. No signup/login exists.
PRD ref: `prd.md > The Core Journey` step 1, `prd.md > Screens and Layout`.

### Onboarding conversation — `src/components/Onboarding.tsx`
Reuses the chat route with an onboarding system prompt; GLM asks a few facts one at a time; answers persist as messages and distill into the first `memories`. While onboarding is active, the envelope carries an extra field, `onboarding_complete`; the route flips `profile.onboarding_done` when GLM sets it true (it has asked enough) and the UI switches to the main chat.
PRD ref: `prd.md > Onboarding & Memory Seeding`.

### Main chat — `src/components/ChatView.tsx`, `src/components/Message.tsx`
Conversation view; header with a **New session** button (creates an empty session row and swaps it in as active) beside the hamburger; input area with mic (Web Speech API → editable input text); markdown rendering; panels render above their answer.
PRD ref: `prd.md > The Core Journey` steps 3–4, `prd.md > Voice Input`, `prd.md > Look and Feel`.

### Chat turn route — `src/app/api/chat/route.ts`
The loop in one place: persist user message → recall → build prompt → GLM call → parse envelope → persist answer + sources → memory-extraction call → upsert distilled memories (+ FTS index). Returns the envelope JSON.
PRD ref: engine behind `prd.md > Session Continuity`, `prd.md > Memory Recall`, `prd.md > Repetition Guard`, `prd.md > Visible vs. Invisible Memory`.

### Continuity responder — inside the chat route
"Let's continue" is detected as a case-insensitive literal match on "let's continue" (plus "lets continue" / "let us continue") in a fresh session's first user message — no model classification needed. On a match: last session's tail + its memories → summary + proposed next step; empty store → clarifying question.
PRD ref: `prd.md > Session Continuity`.

### Recall engine — `src/lib/memory.ts`
FTS5 MATCH over `memories_fts` from the user's words; results must clear the **relevance floor** — a tunable bm25 rank threshold, tuned against the seed script — and survivors return as snippets with session provenance for both the prompt and the panel. Repetition detection is separate and simpler: a bounded `LIKE` scan over `messages.content` for distinctive request phrases (PoC-sized; no second FTS table in v1).
PRD ref: `prd.md > Memory Recall`, `prd.md > Repetition Guard`.

### Thought-signature panel — `src/components/ThoughtSignature.tsx`
Collapsible panel above the answer when `memory_used` is true: source session and date, what was taken, why it's relevant now — straight from the envelope. Routine answers render nothing.
PRD ref: `prd.md > Visible vs. Invisible Memory`.

### History drawer — `src/components/HistoryDrawer.tsx` + `src/app/api/sessions/route.ts`
Hamburger toggles the session list; tapping one makes that session the **active** one — resumable, with new messages appending to it. A "New session" action at the top of the list does the same for an empty row. Reads the same SQLite store.
PRD ref: `prd.md > History View`.

### Error & retry — ChatView state + the chat route's error contract
The pending message is held in client state until a response arrives; failure renders an error + retry; retry resends the identical message without retyping.
PRD ref: `prd.md > Failure & Recovery`.

## Data Model

SQLite file `data/memory.db`, Drizzle schema in `src/lib/schema.ts`:

- **sessions** — id, title (derived from first user words), created_at, updated_at. *Come back:* history lists all; opening one loads its messages.
- **messages** — id, session_id → sessions, role (user/assistant), content, created_at. *Updated:* appended per turn; a failed turn appends nothing — the pending message lives in client state until success.
- **memories** — id, content (one distilled fact/decision/topic), source_session_id → sessions, created_at. *Updated:* inserted by the extraction step; this is the long-term store recall reads from.
- **memories_fts** — FTS5 virtual table indexing `memories.content`, written alongside each memory insert in `memory.ts`. *Why:* keyword recall with session provenance, zero extra service.
- **profile** — key, value (`onboarding_done`, user name). *Updated:* when the route sees `onboarding_complete: true` in an onboarding envelope.

Persistence summary: everything except the in-flight pending message lives in this one file — leave and return, and both the conversation and the memory are still there. "Short-term memory" = the current session's recent messages passed in the prompt, plus that client-held pending message.

## File Structure

```
personal-ai/
├── devpost/                          # planning docs (this workspace)
├── data/
│   └── memory.db                     # SQLite store (gitignored)
├── src/
│   ├── app/
│   │   ├── layout.tsx                # theme tokens via prefers-color-scheme
│   │   ├── page.tsx                  # Get Started → Onboarding → ChatView gating
│   │   ├── globals.css               # palette/spacing tokens, airy styles
│   │   └── api/
│   │       ├── chat/route.ts         # the turn loop (recall → prompt → GLM → persist)
│   │       └── sessions/route.ts     # history list + single-session fetch
│   ├── components/
│   │   ├── GetStarted.tsx
│   │   ├── Onboarding.tsx
│   │   ├── ChatView.tsx              # conversation + input + mic + hamburger
│   │   ├── Message.tsx               # markdown, airy long-form rendering
│   │   ├── ThoughtSignature.tsx      # collapsible recall panel
│   │   └── HistoryDrawer.tsx
│   └── lib/
│       ├── llm.ts                    # the only module that calls NVIDIA NIM
│       ├── memory.ts                 # FTS5 recall, repetition guard, extraction
│       ├── db.ts                     # better-sqlite3 + Drizzle wiring
│       └── schema.ts                 # table definitions
├── scripts/
│   └── seed.ts                       # seeds demo sessions/memories for the quality-bar check
├── .env.local                        # NVIDIA_API_KEY (gitignored)
└── package.json
```

## External Services and Dependencies

**NVIDIA NIM — the only external service.**
- Call: `POST {NIM base URL}/chat/completions` (OpenAI-compatible), header `Authorization: Bearer $NVIDIA_API_KEY`. Exact base URL confirmed in current docs at build start (NIM docs: https://docs.api.nvidia.com/nim/reference/llm-apis).
- Payload: `{ model: "z-ai/glm-5.3-flash", messages: [...], temperature }` — standard OpenAI chat-completion shape; the spec asks GLM to answer *inside* a JSON envelope.
- Two call kinds per turn: the answer call and a small memory-extraction call. No embeddings in v1.
- Model verified listed on NIM's LLM APIs page (2026-10-15). Free credits/rate limits: verify at build start.

**In-repo dependencies** (local, no keys): `next`, `react`, `better-sqlite3` (https://github.com/WiseLibs/better-sqlite3), `drizzle-orm` (https://orm.drizzle.team), `openai` SDK (https://github.com/openai/openai-node), `react-markdown` (https://github.com/remarkjs/react-markdown).

**The envelope** the answer call must return (prompt-enforced, parsed in `llm.ts`):

```json
{ "answer": "markdown string",
  "memory_used": true,
  "sources": [{ "session_id": 12, "date": "2026-10-02",
                "taken": "the CV request and what was made",
                "why_now": "the user asked again" }] }
```

`onboarding_complete` (boolean) appears in the envelope only while onboarding is active — see *Onboarding conversation*.

## Important Failure Modes

- **NVIDIA call fails or hangs** → every model call carries a 60-second timeout, so a hang becomes the same failure: error message + retry button; the pending message stays in client state until answered. PRD ref: `prd.md > Failure & Recovery`.
- **Envelope comes back malformed** → one repair re-prompt; if still bad, show the raw text as a plain answer without a panel — never block the user on a formatting failure.
- **The extraction call fails** → it never fails the user-facing turn: the answer is already saved and shown; the memory distillation is skipped and logged for the POC.
- **FTS returns junk / nothing clears the relevance floor** → answer with no recalled context; invisible mode is the default, panels only on real hits. PRD ref: `prd.md > Visible vs. Invisible Memory`.
- **Day one, empty store** → continuity and recall prompts explicitly forbid inventing history; GLM asks a clarifying question instead. PRD ref: `prd.md > States and Boundaries` ("Empty memory").
- **Browser without the Web Speech API** → the mic button isn't rendered; typing is unaffected.

## What Was Simplified and Why

- **Non-streaming JSON envelope** instead of token streaming — the panel fields need structure; the cost is a typing indicator instead of live text. Streaming is later polish.
- **FTS5 keyword recall** instead of embeddings/vector DB — your PRD's recorded "keyword-based" decision; zero extra services. Upgrade path recorded in Decisions.
- **Prompt-driven onboarding** inside the normal chat pipeline instead of a separate flow engine — one code path proves the kernel.
- **Web Speech API dictation** instead of custom/native STT plumbing — free, Chromium-first, degrades gracefully elsewhere (per `prd.md > Voice Input`).
- **Local-only, no deployment** — the demo is a screen recording; hosting was explicitly cut in scope.

## Decisions and Open Issues

**Learner choices (agreed in conversation):**
- **TypeScript + Next.js for v1** — accepted the recommendation after weighing Python and Flutter. Flutter is the candidate for the later mobile/sync iteration; your cross-device ambition is a recorded **north star, not v1 scope**, and the SQLite schema stays portable for it.
- **`z-ai/glm-5.3-flash` on NVIDIA NIM** — your pick; availability verified against NIM's model list before recording.
- **Cartesia (Ink 2 / Sonic 3.5) parked to Later Enhancements** — voice is modality, not the memory kernel; the PRD's device-STT decision stands, and v1 keeps exactly one external service.
- **Theme follows the device automatically** — dark and light both ship via `prefers-color-scheme`.

**Derived from your choices (implementation detail, not new decisions):** better-sqlite3 + Drizzle; FTS5 as the recall engine; the JSON envelope; the one-process architecture; react-markdown.

**The useful unknown — keyword-retrieval quality bar.** Your PRD flagged that how good keyword matching must *feel* was unresolved. Resolved here as a testable target: with five or more real or seeded sessions, mentioning a distinctive phrase from an old session must surface that session's memory among the top FTS hits, and recall must **not** fire on unrelated messages. Verified during the build with a small seed script before the demo is recorded. If keyword matching misses the bar, the recorded upgrade is embeddings served via NIM — the schema doesn't change.

**Resolved PRD open questions:** storage engine + ORM = SQLite with better-sqlite3 + Drizzle (your lean, confirmed); keyword quality bar = the testable target above; theme = device auto. No consequential gaps remain open.

**Still open, non-blocking:** session titles are auto-derived for v1 (renaming is later polish); FTS5 tokenizer behavior on mixed-language text gets a glance during the seed-script verification.