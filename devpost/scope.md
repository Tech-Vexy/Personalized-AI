---
doc: scope
status: approved
---

# Personal AI That Remembers (working title)

A personal AI chat that actually remembers — one unified memory across all sessions, so a new conversation never starts from a clean slate.

## The Unique Kernel
Memory with judgment. The AI reliably carries context across sessions and knows when a memory applies versus when it should be disregarded — seamless by default, with visible receipts ("pulling from your Oct 2 session…") when proof matters. Today's chatbots forget nearly 100% of conversations; a new chat is a clean slate, and users have to keep saying "remember we discussed this." This one doesn't.

## Who It's For
The learner themself, first: someone who juggles seven chatbots daily (Claude, Gemini, ChatGPT, Grok, Kimi, Qwen, DeepSeek), works on thought-oriented ideas over weeks and months, and is tired of re-explaining context and getting "I have no memory of such a discussion." Built for one local user; useful to others is a later ambition, not a v1 requirement.

## The Core Loop
Open the app — even a brand-new session — and say "let's continue." The AI picks up the thread: "yesterday we looked at X, today we move on to Y." No hunting through session history. As the conversation touches older ground, past sessions resurface on their own via keyword-based recall, all from one unified memory. They come back because context accumulates instead of evaporating.

## Inspiration & Identity
The daily chatbots the learner uses and their memory failures; the target feeling is *relief* — no juggling apps, no pasting chatbot A's answer into chatbot B for critique just to grasp one concept. Voice: a thinking companion, not a flatterer — original, thought-oriented responses rather than "a pat on the shoulder or an unwarranted critique" (that tone is realized fully in the later critique mode). No specific reference URLs shared.

## Why This Matters to the Learner
In their words: current bots are "stateless," memory is "short-lived or flawed"; "I constantly have to tell them remember we discussed this." Memory is "the building block"; killing the app-juggling is "a perk." The payoff they picture when using it: relief.

## What "Working" Looks Like
On screen, in under a minute of demo: open a fresh session, type "let's continue," and the AI summarizes where the last session left off and proposes the next step — unprompted. Then the conversation brushes an older topic and the AI correctly resurfaces it (showing its source when in visible mode). The "oh, that's cool" beat is the clean-slate session that isn't actually clean.

## The POC Boundary
In: a single-user chat app; unified cross-session memory store; "let's continue" session continuity; keyword-based recall of older sessions; memory works in both invisible (seamless) and visible (shows what it recalled and from where) modes. Version one relies on RAG over stored memories plus a deployed (hosted API) model — no model training.

Memory is a first-class citizen: short-term (session) memory is automatically promoted into long-term memory, which is uniquely persistent and scalable. For v1, long-term memory lives in a database, indexed for faster fetching.

## Later
- The critique / second-opinion mode — original, thought-oriented pushback that replaces carrying chatbot A's answer to chatbot B. Builds on memory, so it comes after.
- A memory dashboard: view, edit, delete what the AI remembers.
- Deeper long-term profile building (goals, ongoing projects tracked over months).
- Fine-tune a model and serve it locally with Microsoft Foundry Local.

## Explicitly Cut
- **Fine-tuning / custom model training** — v1 proves the idea with RAG + a deployed model; a fine-tuned local model is a later-iteration path, not needed to prove memory.
- **Multi-user accounts and onboarding for others** — it's the learner's tool first; one local user proves the kernel.
- **Mobile app and voice** — a chat interface demonstrates the loop; the kernel is memory, not modality.
- **Deployment/hosting of the app** — the hackathon targets a local demo; deployment is optional.
