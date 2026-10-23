---
doc: prd
status: approved
---

# Personal AI That Remembers — Product Requirements

A single-user personal AI chat whose defining behavior is that it actually remembers — across sessions, on one device.
Source: `scope.md > The Core Loop`, `scope.md > The Unique Kernel`. No accounts, no cloud, pure conversation.

## The Core Journey

1. **First launch — Get Started.** A page that describes what the app does. No signup, no login — there is nothing to authenticate into.
2. **Onboarding — the AI asks for a few facts.** Not a form: a conversation. The answers are the first entries in long-term memory, so even session one has something to remember.
3. **Main screen.** A chat input (with a mic button) and the conversation. That's the whole screen — no history UI anywhere.
4. **"Let's continue."** Every launch of the app opens a fresh conversation. Saying "let's continue" as the first message makes the AI summarize where the last session left off and propose the next step. On day one — with nothing to continue — the AI asks for clarification instead of inventing a fake "yesterday."
5. **Talking normally.** As the conversation touches older ground, relevant past sessions resurface on their own from the unified memory. Most of the time this is invisible; when the AI judges that showing its work matters, a collapsible thought-signature panel appears above the answer: which session it pulled from, what it took, why it's relevant now.
6. **Asking twice.** If someone requests something they already got — the CV from last week — the AI retrieves instead of regenerating: it points back to the prior conversation and what was made there.
7. **A stateless surface, a stateful AI.** The app holds nothing: every launch opens a clean conversation, and nothing old is ever rendered back. History lives entirely inside the memory kernel — asking the AI is the only way to reach the past, which is exactly how it should feel.
8. **Success.** The two demo beats from `scope.md > What "Working" Looks Like`, plus one new one: the clean-slate session that isn't clean; keyword recall that names its source; retrieval instead of regeneration.

## Screens and Layout

- **Get Started** — a single page introducing the features; a button flows onward. No signup/login buttons exist.
- **Onboarding** — conversational; the AI asks a few questions about the user, one at a time.
- **Main chat** — conversation view; input area at the bottom with a mic button beside text input. Thought-signature panels, when shown, render above the response they explain. There is no hamburger and no history screen.

## Look and Feel

Reference points: **Gemini and Claude** — clean, calm, refined; comfortable whitespace; long responses stay airy and readable. Explicitly avoid the ChatGPT-style bulky rendering of large responses. (Dark vs. light was not specified; resolve at styling time in spec/build.)

## Features and Behavior

The product is one surface and one loop, so behaviors are listed flat.

### Onboarding & Memory Seeding
The AI opens onboarding by asking a few facts about the user, conversationally. Answers become the first long-term memories.
- [ ] After onboarding, the AI can correctly reference a seeded fact in later conversation.
- [ ] Onboarding feels like chat, not a form (no questionnaire UI).

### Session Continuity — "let's continue"
Every launch opens a fresh conversation; "let's continue" as its first message produces a summary of where the last session left off and a proposed next step.
- [ ] After reopening the app, "let's continue" yields an accurate "yesterday we looked at…, today…" response without the user hunting through anything.
- [ ] On day one (facts but no sessions), "let's continue" produces a clarifying question — never a fabricated recap.

### Memory Recall — unified store, keyword retrieval
Past sessions resurface automatically when the conversation touches their subject matter, from one unified store spanning all sessions.
- [ ] Mentioning a topic from an old session triggers recall of that session's relevant content.
- [ ] Recall works across any session boundary (not per-chat silos).

### Visible vs. Invisible Memory — the AI's judgment
The AI decides, moment by moment, whether to show its work. Invisible: seamless answers. Visible: a collapsible thought-signature panel above the answer showing which session it pulled from, what it took, and why it's relevant now.
- [ ] When a panel is shown, it names the source session and the recalled content.
- [ ] Panels appear only when the AI judges it matters; routine answers flow without panels.

### Repetition Guard — retrieval over regeneration
Requesting something already produced in a past session triggers retrieval: the AI points back to the prior conversation and its content instead of generating a new variant.
- [ ] Repeating a past request yields a reference to the original ("you asked for this on Oct 2 — here it is"), not a fresh regeneration.

### Stateless Surface — the app holds nothing, the AI holds everything
No history UI exists: no hamburger, no session list, no "new session" button. Each app launch starts a clean conversation; internal sessions rotate automatically and exist only so the kernel can attribute memories. The user never reviews history — they just ask the AI.
- [ ] Relaunching the app opens an empty conversation — no old messages restored to the screen.
- [ ] Past context still shapes answers after a relaunch (via the kernel, not the UI).

### Voice Input
The mic button captures speech through the device/OS built-in speech-to-text; no custom STT or TTS.
- [ ] Dictated speech lands in the input as editable text before sending.

### Failure & Recovery
If the model call fails, the user sees an error message with a retry button. The sent message is held in short-term memory until a response arrives.
- [ ] With the network interrupted, an error + retry appears; after retry, the original message is answered without retyping.

## States and Boundaries

- **First use** — Get Started → onboarding; no accounts anywhere; single local user, data on their device (`scope.md > Explicitly Cut`).
- **Empty memory** — the AI asks for clarification rather than inventing continuity.
- **Error state** — model call failure shows an error + retry; the pending message survives in short-term memory until answered.
- **Persistence** — all conversations persist in unified long-term memory; short-term memory covers the current session's in-flight state.
- **Memory visibility** — controlled entirely by the AI's judgment; there is no user-facing toggle (ephemeral mode was considered and cut).
- **Who can see what** — one user; nothing leaves the device except model API calls.

## Product Decisions

- **No accounts or auth in v1** — data stays on the user's device; auth would only be needed with a cloud database, which v1 avoids (learner's reasoning).
- **Mic input kept, via device/OS built-in speech-to-text** — "some thoughts get lost while typing"; no custom STT/TTS plumbing in v1.
- **Ephemeral mode cut after being proposed** — the design philosophy is efficient memory management with on-demand retrieval; the agent loop decides what is permanent and what is transient.
- **Visible vs. invisible memory decided by the AI's judgment** — rendered as thought-signature-style panels; no user-facing toggle.
- **App stateless, AI stateful (2026-10-23)** — the user never reviews history or manages sessions; history lives inside the memory kernel and the surface opens clean on every launch. Replaces the planned history drawer and New-session button (learner: "remember history is all part of memory kernel and not app… they just ask the AI").
- **Brain: `gemini-3.8-flash` on Google AI (2026-10-23)** — replaces NVIDIA NIM GLM-5.3-flash after live use: 44–107s silent waits read as "the AI never responds" even though replies landed. Google's OpenAI-compatible endpoint keeps the envelope architecture unchanged.
- **v1 is pure conversation** — generated files don't prove memory; the repetition-waste insight (regenerating a CV you already got) is recorded as the future rationale for an artifacts/library feature.
- **Visual direction: Gemini/Claude-like** — calm, clean, airy long responses; explicitly avoid ChatGPT-style bulky large responses.

## What We're Building

Everything the proof of concept must do to be complete:

1. Get Started page (no accounts).
2. Conversational onboarding that seeds long-term memory.
3. Main chat with text input and device-STT mic button — no history chrome on the surface.
4. "Let's continue" session continuity from the unified memory store.
5. Keyword-based recall of older sessions, invisible by default with AI-judged thought-signature panels.
6. Repetition guard — retrieval instead of regeneration for already-made things.
7. Stateless surface — clean conversation on every launch; the memory kernel provides all continuity.
8. Error + retry handling that preserves the pending message.

## Deferred From the POC

- **Generated files & artifacts library** — the AI producing downloadable files, with a retrieval surface. The repetition scenario makes this genuinely useful, but file generation/storage isn't needed to prove memory. First in line after the POC.
- **Memory dashboard** (view/edit/delete memories) — trust tooling; the thought-signature panel is the v1 stand-in.
- **Critique / second-opinion mode** — the original, thought-oriented pushback from `scope.md > Later`; builds on memory.
- **Deeper long-term profile building** — goals and ongoing projects tracked over months.

## Possible Later Enhancements

- Cloud sync with authentication and per-user data protection — the path that would require auth.
- Fine-tuned local model served with Microsoft Foundry Local (from `scope.md > Later`).
- TTS output for spoken replies.

## Non-Goals

- **Multi-user accounts, sign-up/login, cloud sync** — cut in scope; a single local user proves the kernel.
- **Custom speech-to-text or text-to-speech** — device features only.
- **Mobile app** — the chat interface proves the loop.
- **Deployment/hosting of the app** — local demo; deployment is optional per the hackathon.
- **Model fine-tuning/training** — RAG over stored memories plus a hosted model proves the idea.

## Open Questions

- **Storage engine, ORM, and framework** — the learner leans SQLite (on-device) and notes the ORM depends on the framework. Must be answered in `4-spec` before spec approval; does not block this PRD.
- **Keyword-retrieval quality bar** — how good keyword matching must feel for recall to seem smart. To be resolved in `4-spec`/early build as a testable target; does not block this PRD.
- **Dark vs. light theme** — not established; resolve at styling time.


