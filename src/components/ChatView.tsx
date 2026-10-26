"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Message, { type WireMessage } from "./Message";
import type { EnvelopeSourceView } from "./ThoughtSignature";

type ChatResponse = {
  sessionId: number;
  userMessage: WireMessage;
  assistantMessage: WireMessage;
  memoryUsed?: boolean;
  sources?: EnvelopeSourceView[];
};

type SessionListItem = {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
};

// Web Speech API interface definitions
interface SpeechRecognitionEventLike {
  results: {
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
    };
  };
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}

function formatSessionDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function ChatView() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [items, setItems] = useState<WireMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingHasContent, setStreamingHasContent] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [micNotice, setMicNotice] = useState<string | null>(null);

  // Sidebar history state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessionsList, setSessionsList] = useState<SessionListItem[]>([]);
  const [loadingSessionId, setLoadingSessionId] = useState<number | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<number | null>(null);

  /** The message held in client state until an answer exists (spec.md > Error & retry). */
  const [pending, setPending] = useState<{ text: string; localId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Detect speech recognition support safely on mount
  useEffect(() => {
    const SpeechAPI =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;

    if (SpeechAPI) {
      setSpeechSupported(true);
    }
  }, []);

  // Fetch recent sessions list
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const data = (await res.json()) as { sessions?: SessionListItem[] };
      if (Array.isArray(data.sessions)) {
        setSessionsList(data.sessions);
      }
    } catch (e) {
      console.error("[sessions] failed to load history:", e);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Legible waiting state: elapsed seconds counter while model thinks
  useEffect(() => {
    if (!sending) {
      setElapsedSeconds(0);
      setStreamingHasContent(false);
      return;
    }
    const timer = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [sending]);

  // Keep newest message in view
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, items[items.length - 1]?.content, sending]);

  // Dynamic textarea sizing
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const handleNewChat = useCallback(() => {
    if (sending) return;
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    }
    setSessionId(null);
    setItems([]);
    setInput("");
    setPending(null);
    setError(null);
    setMicNotice(null);
    taRef.current?.focus();
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, [isListening, sending]);

  const handleSelectSession = useCallback(
    async (id: number) => {
      if (sending || id === sessionId) return;
      setLoadingSessionId(id);
      setError(null);
      try {
        const res = await fetch(`/api/sessions?id=${id}`);
        if (!res.ok) throw new Error("Could not load session");
        const data = (await res.json()) as {
          session: SessionListItem;
          messages: WireMessage[];
        };
        setSessionId(id);
        setItems(data.messages || []);
        setPending(null);
        setInput("");
        if (typeof window !== "undefined" && window.innerWidth < 768) {
          setSidebarOpen(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
      } finally {
        setLoadingSessionId(null);
      }
    },
    [sending, sessionId],
  );

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, id: number) => {
      e.stopPropagation();
      if (deletingSessionId === id) return;
      setDeletingSessionId(id);
      try {
        const res = await fetch(`/api/sessions?id=${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Could not delete session");
        setSessionsList((prev) => prev.filter((s) => s.id !== id));
        if (sessionId === id) {
          handleNewChat();
        }
      } catch (err) {
        console.error("Failed to delete session", err);
      } finally {
        setDeletingSessionId(null);
      }
    },
    [deletingSessionId, handleNewChat, sessionId],
  );

  const toggleMic = useCallback(() => {
    if (!speechSupported) {
      setMicNotice(
        "Microphone speech-to-text uses the Web Speech API (available in Google Chrome and Microsoft Edge).",
      );
      setTimeout(() => setMicNotice(null), 5000);
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechAPI =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;

    if (!SpeechAPI) return;

    try {
      const recognition = new SpeechAPI();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        const transcript = event.results[0]?.[0]?.transcript ?? "";
        if (transcript) {
          setInput((prev) => {
            const trimmed = prev.trim();
            return trimmed ? `${trimmed} ${transcript}` : transcript;
          });
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
      setMicNotice(null);
    } catch {
      setIsListening(false);
    }
  }, [isListening, speechSupported]);

  const send = useCallback(
    async (text: string, existing?: { id: number }) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      if (isListening) {
        recognitionRef.current?.stop();
        setIsListening(false);
      }

      const userLocalId = existing?.id ?? -Date.now();
      const assistantLocalId = -Date.now() - 1;

      if (existing) {
        setItems((prev) => prev.map((m) => (m.id === userLocalId ? { ...m, failed: false } : m)));
      } else {
        setItems((prev) => [
          ...prev,
          { id: userLocalId, role: "user", content: trimmed, createdAt: new Date().toISOString() },
        ]);
        setInput("");
      }

      setPending({ text: trimmed, localId: userLocalId });
      setError(null);
      setSending(true);
      setStreamingHasContent(false);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, sessionId, stream: true }),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errData.error ?? `The reply failed (HTTP ${res.status}).`);
        }

        const contentType = res.headers.get("content-type") ?? "";

        // Real-Time Token Streaming via SSE
        if (contentType.includes("text/event-stream") && res.body) {
          // Placeholder assistant message to accumulate live tokens
          setItems((prev) => [
            ...prev.filter((m) => m.id !== assistantLocalId),
            {
              id: assistantLocalId,
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
            },
          ]);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let currentAssistantText = "";
          let memoryUsed = false;
          let sources: EnvelopeSourceView[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() ?? "";

            for (const block of blocks) {
              if (!block.trim()) continue;
              const lines = block.split("\n");
              let eventType = "message";
              let dataStr = "";

              for (const line of lines) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                  dataStr = line.slice(5).trim();
                }
              }

              if (!dataStr) continue;

              if (eventType === "metadata") {
                try {
                  const meta = JSON.parse(dataStr) as {
                    memoryUsed?: boolean;
                    sources?: EnvelopeSourceView[];
                  };
                  memoryUsed = meta.memoryUsed === true;
                  sources = Array.isArray(meta.sources) ? meta.sources : [];
                  setItems((prev) =>
                    prev.map((m) =>
                      m.id === assistantLocalId ? { ...m, memoryUsed, sources } : m,
                    ),
                  );
                } catch (e) {
                  console.error("Failed to parse metadata event", e);
                }
              } else if (eventType === "delta") {
                try {
                  const delta = JSON.parse(dataStr) as { text?: string };
                  if (typeof delta.text === "string" && delta.text.length > 0) {
                    currentAssistantText += delta.text;
                    setStreamingHasContent(true);
                    setItems((prev) =>
                      prev.map((m) =>
                        m.id === assistantLocalId
                          ? { ...m, content: currentAssistantText, memoryUsed, sources }
                          : m,
                      ),
                    );
                  }
                } catch (e) {
                  console.error("Failed to parse delta event", e);
                }
              } else if (eventType === "done") {
                try {
                  const doneData = JSON.parse(dataStr) as {
                    sessionId: number;
                    userMessage: WireMessage;
                    assistantMessage: WireMessage;
                    memoryUsed?: boolean;
                    sources?: EnvelopeSourceView[];
                  };
                  const {
                    sessionId: nextSessionId,
                    userMessage,
                    assistantMessage,
                    memoryUsed: doneMemUsed,
                    sources: doneSources,
                  } = doneData;

                  setSessionId(nextSessionId ?? null);
                  setItems((prev) => [
                    ...prev.filter((m) => m.id !== userLocalId && m.id !== assistantLocalId),
                    userMessage,
                    {
                      ...assistantMessage,
                      content: assistantMessage?.content || currentAssistantText,
                      memoryUsed: doneMemUsed ?? memoryUsed,
                      sources: doneSources ?? sources,
                    },
                  ]);
                  setPending(null);
                  void fetchSessions();
                } catch (e) {
                  console.error("Failed to parse done event", e);
                }
              } else if (eventType === "error") {
                try {
                  const errPayload = JSON.parse(dataStr) as { error?: string };
                  throw new Error(errPayload.error || "Streaming error occurred");
                } catch (e) {
                  if (e instanceof Error && e.message !== "Streaming error occurred") {
                    throw e;
                  }
                  throw new Error(dataStr || "Streaming error occurred");
                }
              }
            }
          }
        } else {
          // Non-streaming fallback
          const data = (await res.json().catch(() => ({}))) as Partial<ChatResponse> & {
            error?: string;
          };
          const { sessionId: nextSessionId, userMessage, assistantMessage } = data;
          if (!userMessage || !assistantMessage) {
            throw new Error(data.error ?? `The reply failed (HTTP ${res.status}).`);
          }
          setSessionId(nextSessionId ?? null);
          setItems((prev) => [
            ...prev.filter((m) => m.id !== userLocalId),
            userMessage,
            {
              ...assistantMessage,
              memoryUsed: data.memoryUsed,
              sources: data.sources,
            },
          ]);
          setPending(null);
          void fetchSessions();
        }
      } catch (err) {
        setItems((prev) => prev.map((m) => (m.id === userLocalId ? { ...m, failed: true } : m)));
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setSending(false);
      }
    },
    [fetchSessions, isListening, sending, sessionId],
  );

  const retry = useCallback(() => {
    if (pending) void send(pending.text, { id: pending.localId });
  }, [pending, send]);

  return (
    <div className={`app-layout ${sidebarOpen ? "sidebar-open" : ""}`}>
      {/* Mobile Backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* History Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Conversation history">
        <div className="sidebar-header">
          <div className="sidebar-title-row">
            <span className="sidebar-title">Conversations</span>
            <button
              type="button"
              className="sidebar-close-btn"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close conversation history"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="sidebar-new-btn"
            onClick={handleNewChat}
            disabled={sending}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Chat
          </button>
        </div>

        <div className="sidebar-list">
          {sessionsList.length === 0 ? (
            <p className="sidebar-empty">No conversations yet.</p>
          ) : (
            sessionsList.map((s) => {
              const isActive = s.id === sessionId;
              const isLoadingThis = loadingSessionId === s.id;
              const isDeletingThis = deletingSessionId === s.id;
              return (
                <div
                  key={s.id}
                  className={`session-item ${isActive ? "active" : ""} ${
                    isLoadingThis ? "loading" : ""
                  }`}
                  onClick={() => handleSelectSession(s.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void handleSelectSession(s.id);
                    }
                  }}
                  aria-current={isActive ? "true" : undefined}
                >
                  <div className="session-item-content">
                    <span className="session-title">{s.title || "Untitled conversation"}</span>
                    <span className="session-date">{formatSessionDate(s.updatedAt)}</span>
                  </div>
                  <button
                    type="button"
                    className="session-delete-btn"
                    onClick={(e) => handleDeleteSession(e, s.id)}
                    disabled={isDeletingThis}
                    title="Delete conversation"
                    aria-label={`Delete conversation ${s.title}`}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Main App Frame */}
      <div className="app app-main">
        <header className="app-header">
          <div className="app-header-left">
            <button
              type="button"
              className="sidebar-toggle-btn"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label={sidebarOpen ? "Close history" : "Open history"}
              title="Conversation history"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <p className="app-title">
              Personal AI <span>· that remembers</span>
            </p>
          </div>

          <button
            type="button"
            className="new-chat-btn"
            onClick={handleNewChat}
            disabled={sending}
            title="Start a fresh conversation"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Chat
          </button>
        </header>

        <main className="chat">
          {items.length === 0 && !sending ? (
            <div className="chat-empty">
              <p className="chat-empty-title">What are you thinking through?</p>
              <p className="chat-empty-sub">
                Every conversation starts clean. What the AI learns along the way, it keeps.
              </p>
            </div>
          ) : (
            <div className="chat-column">
              {items.map((m) => (
                <Message
                  key={m.id}
                  message={m}
                  failed={m.failed}
                  failReason={m.id === pending?.localId ? (error ?? undefined) : undefined}
                  onRetry={m.failed && m.id === pending?.localId ? retry : undefined}
                />
              ))}
              {sending && !streamingHasContent && (
                <div
                  className="typing-container"
                  role="status"
                  aria-live="polite"
                  aria-label={`The assistant is thinking, elapsed ${elapsedSeconds} seconds`}
                >
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="typing-elapsed">thinking… {elapsedSeconds}s</span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <footer className="composer">
          <form
            className="composer-inner"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <button
              type="button"
              className={`composer-mic ${isListening ? "listening" : ""}`}
              onClick={toggleMic}
              disabled={sending}
              title={
                !speechSupported
                  ? "Microphone speech-to-text requires Google Chrome or Microsoft Edge"
                  : isListening
                  ? "Listening… click to stop"
                  : "Dictate via microphone"
              }
              aria-label={isListening ? "Stop dictation" : "Start dictation"}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </button>

            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder={isListening ? "Listening… speak now" : "Write a message…"}
              aria-label="Message"
              disabled={sending}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />

            <button
              className="composer-send"
              type="submit"
              disabled={sending || input.trim() === ""}
            >
              Send
            </button>
          </form>
          {micNotice && <p className="composer-notice">{micNotice}</p>}
          <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
        </footer>
      </div>
    </div>
  );
}
