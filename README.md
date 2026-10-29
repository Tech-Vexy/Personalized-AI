# Personal AI That Remembers

A single-user personal thinking companion on your local device whose defining behavior is that it actually remembers across sessions.

Built with Next.js, SQLite (via `better-sqlite3` and `drizzle-orm`), Turso LibSQL Cloud Sync, NVIDIA NIM (`nvidia/nemotron-3.5-bolt-e4b` & `nvidia/nemotron-3.5-super-vl-120b-a12b`), Deepgram Nova-2, and Cartesia Sonic 3.6.

---

## Key Features

- **Unified Long-Term Memory Kernel:** Durable facts, topics, and decisions are distilled and indexed in SQLite FTS5 with prefix wildcards (`"${w}"*`) and a bm25 relevance floor (`-0.6`), resurfacing context when relevant across session boundaries with fuzzy deduplication and smart distillation gating.
- **Hybrid Semantic Vector Search:** Dense 128-dimensional L2-normalized vector embeddings combined with lexical BM25 matching via **Reciprocal Rank Fusion (RRF)**, giving both exact keyword accuracy and conceptual semantic recall.
- **Thought Signature Receipts:** When the companion draws on long-term memory, a collapsible thought-signature panel reveals the source session, date, recalled excerpt, and why it is relevant now.
- **Multimodal Vision:** Powered by NVIDIA Nemotron 3.5 Super VL (`nvidia/nemotron-3.5-super-vl-120b-a12b`). Drag and drop, paste from clipboard (`Ctrl+V`), or upload images and diagrams for visual reasoning and visual memory extraction.
- **Turso LibSQL Cloud Sync & Backup:** Zero-dependency LibSQL v2 HTTP Pipeline client for bidirectional cloud database replication to Turso, alongside one-click portable JSON database snapshot export and restore.
- **Local-First & Offline Resilient:** Local SQLite remains the primary low-latency engine. Works seamlessly completely offline; cloud sync runs gracefully whenever network connectivity is available.
- **Real-Time Token Streaming:** Server-Sent Events (SSE) stream tokens directly from NVIDIA NIM into the UI as they generate, eliminating perceived latency.
- **Session Continuity ("Let's continue"):** Reopen the app and type `"let's continue"` to get an unprompted recap of where the previous conversation left off and a proposed next step.
- **Repetition Guard:** If you request something previously generated in an earlier conversation, the system points back to the prior session and deliverable rather than regenerating a new variant.
- **Recent Sessions History Drawer:** Collapsible sidebar with active conversation switching, timestamp indicators, and conversation deletion.
- **Speech Input & Legible Waiting State:** Dual-engine speech-to-text with Deepgram Nova-2 and Web Speech API into editable text across all browsers, plus an elapsed-seconds thinking indicator (`thinking… 4s`).
- **Voice Read-Aloud (TTS):** Cartesia Sonic 3.6 text-to-speech with the British Gemma voice ("Gemma - Decisive Agent") allows listening to any assistant response with sub-100ms generative audio.
- **Memory Vault UI:** Comprehensive visual inspector for all distilled memories, manual memory creation, search, deletion, and conversational memory eradication ("forget about X").

---

## Getting Started

### Prerequisites

- Node.js 20+
- An NVIDIA NIM API key (from [build.nvidia.com](https://build.nvidia.com))
- (Optional) A Turso LibSQL database URL and API token (from [turso.tech](https://turso.tech))
- (Optional) Deepgram & Cartesia API keys for high-fidelity voice dictation and TTS

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
   Add your API keys:
   ```env
   NVIDIA_API_KEY=nvapi-...
   # Optional cloud sync & voice:
   TURSO_DATABASE_URL=libsql://<your-db>.turso.io
   TURSO_API_KEY=<your-turso-key>
   DEEPGRAM_API_KEY=<your-deepgram-key>
   CARTESIA_API_KEY=<your-cartesia-key>
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Project Structure & Architecture

```
├── src/
│   ├── app/
│   │   ├── api/chat/         # Turn loop, real-time SSE streaming, multimodal vision & continuity
│   │   ├── api/memories/     # Memory Vault CRUD & vector synchronization
│   │   ├── api/profile/      # First-launch onboarding gating
│   │   ├── api/sessions/     # Sessions listing, loading & deletion
│   │   ├── api/stt/          # Deepgram Nova-2 speech-to-text
│   │   ├── api/sync/         # Turso cloud sync & JSON snapshot backup/restore
│   │   ├── api/tts/          # Cartesia Sonic 3.6 text-to-speech (Gemma voice)
│   │   ├── globals.css       # Gemini/Claude-inspired design tokens, sync bar & vault styles
│   │   └── page.tsx          # Gated UI root (Get Started → Onboarding → Chat)
│   ├── components/
│   │   ├── ChatView.tsx      # Main conversation view, image dropzone, voice & sync toolbar
│   │   ├── Message.tsx       # Markdown rendering, attached images & thought signature
│   │   ├── ThoughtSignature.tsx # Collapsible receipts panel
│   │   ├── GetStarted.tsx    # First-launch introduction
│   │   └── Onboarding.tsx    # Conversational memory seeding
│   └── lib/
│       ├── db.ts             # SQLite & Drizzle initialization
│       ├── schema.ts         # SQLite schema (sessions, messages, memories, profile)
│       ├── memory.ts         # Hybrid recall (FTS5 + dense vectors), repetition scan, memory extraction
│       ├── llm.ts            # NVIDIA NIM API client (Nemotron text & Nemotron VL vision)
│       ├── tursoSync.ts      # Zero-dependency LibSQL v2 HTTP Pipeline cloud sync client
│       └── vectorSearch.ts   # 128-D dense semantic vector engine & Reciprocal Rank Fusion (RRF)
└── scripts/
    ├── probe-llm.ts          # Provider connectivity & latency probe
    └── seed.ts               # Demo memory seeding & quality bar verification
```
