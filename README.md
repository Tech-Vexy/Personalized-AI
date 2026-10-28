# Personal AI That Remembers

A single-user personal thinking companion on your local device whose defining behavior is that it actually remembers across sessions.

Built with Next.js, SQLite (via `better-sqlite3` and `drizzle-orm`), and NVIDIA NIM (`nvidia/nemotron-3.5-bolt-e4b`).

---

## Key Features

- **Unified Long-Term Memory Kernel:** Durable facts, topics, and decisions are distilled and indexed in SQLite FTS5 with prefix wildcards (`"${w}"*`) and a bm25 relevance floor (`-0.6`), resurfacing context when relevant across session boundaries with fuzzy deduplication and smart distillation gating.
- **Thought Signature Receipts:** When the companion draws on long-term memory, a collapsible thought-signature panel reveals the source session, date, recalled excerpt, and why it is relevant now.
- **Real-Time Token Streaming:** Server-Sent Events (SSE) stream tokens directly from NVIDIA NIM into the UI as they generate, eliminating perceived latency.
- **Session Continuity ("Let's continue"):** Reopen the app and type `"let's continue"` to get an unprompted recap of where the previous conversation left off and a proposed next step.
- **Repetition Guard:** If you request something previously generated in an earlier conversation, the system points back to the prior session and deliverable rather than regenerating a new variant.
- **Recent Sessions History Drawer:** Collapsible sidebar with active conversation switching, timestamp indicators, and conversation deletion.
- **Speech Input & Legible Waiting State:** Dual-engine speech-to-text with Deepgram Nova-2 and Web Speech API into editable text across all browsers, plus an elapsed-seconds thinking indicator (`thinking… 4s`).
- **Voice Read-Aloud (TTS):** Cartesia Sonic 3.6 text-to-speech with the British Gemma voice ("Gemma - Decisive Agent") allows listening to any assistant response with sub-100ms generative audio.
- **Stateless Surface:** Every launch opens a clean, airy conversation with a `+ New Chat` button to start fresh anytime, while the AI retains what it learned.
- **Local-First & Private:** Single local SQLite database (`data/memory.db`). No accounts, no cloud sync, and no third-party tracking.

---

## Getting Started

### Prerequisites

- Node.js 20+
- An NVIDIA NIM API key (get one at [build.nvidia.com](https://build.nvidia.com))
- A Chromium browser (Google Chrome or Microsoft Edge) for voice dictation

### Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Tech-Vexy/Personalized-AI.git
   cd Personalized-AI
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
   Add your NVIDIA NIM key:
   ```env
   NVIDIA_API_KEY=nvapi-...
   # Optional overrides:
   # NIM_BASE_URL=https://integrate.api.nvidia.com/v1
   # NIM_MODEL=nvidia/nemotron-3.5-bolt-e4b
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Project Structure & Architecture

```
devpost-project/
├── devpost/                  # Plan-first artifacts & architecture map
│   ├── scope.md              # Scope definition & POC boundary
│   ├── prd.md                # Product requirements document
│   ├── spec.md               # Technical specification
│   ├── checklist.md          # 9-slice build checklist
│   └── app-map.html          # Standalone architecture guide
├── src/
│   ├── app/
│   │   ├── api/chat/         # Turn loop, real-time SSE streaming, continuity & repetition guards
│   │   ├── api/profile/      # First-launch onboarding gating
│   │   ├── api/sessions/     # Sessions listing, loading & deletion
│   │   ├── api/stt/          # Deepgram Nova-2 speech-to-text
│   │   ├── api/tts/          # Cartesia Sonic 3.6 text-to-speech (Gemma voice)
│   │   ├── globals.css       # Gemini/Claude-inspired design tokens & sidebar styles
│   │   └── page.tsx          # Gated UI root (Get Started → Onboarding → Chat)
│   ├── components/
│   │   ├── ChatView.tsx      # Main conversation view, streaming reader, sidebar & mic
│   │   ├── Message.tsx       # Markdown rendering & thought signature
│   │   ├── ThoughtSignature.tsx # Collapsible receipts panel
│   │   ├── GetStarted.tsx    # First-launch introduction
│   │   └── Onboarding.tsx    # Conversational memory seeding
│   └── lib/
│       ├── db.ts             # SQLite & Drizzle initialization
│       ├── schema.ts         # SQLite schema (sessions, messages, memories, profile)
│       ├── memory.ts         # FTS5 recall, repetition scan, memory extraction
│       └── llm.ts            # NVIDIA NIM API client & structured JSON envelope
└── scripts/
    ├── probe-llm.ts          # Provider connectivity & latency probe
    └── seed.ts               # Demo memory seeding & quality bar verification
```

See [`devpost/app-map.html`](devpost/app-map.html) for an interactive architectural walkthrough.
