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

export default function ChatView() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [items, setItems] = useState<WireMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [micNotice, setMicNotice] = useState<string | null>(null);

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

  // Legible waiting state: elapsed seconds counter while model thinks
  useEffect(() => {
    if (!sending) {
      setElapsedSeconds(0);
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
  }, [items.length, sending]);

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
  }, [isListening, sending]);

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

      const localId = existing?.id ?? -Date.now();
      if (existing) {
        setItems((prev) => prev.map((m) => (m.id === localId ? { ...m, failed: false } : m)));
      } else {
        setItems((prev) => [
          ...prev,
          { id: localId, role: "user", content: trimmed, createdAt: new Date().toISOString() },
        ]);
        setInput("");
      }
      setPending({ text: trimmed, localId });
      setError(null);
      setSending(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, sessionId }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<ChatResponse> & {
          error?: string;
        };
        const { sessionId: nextSessionId, userMessage, assistantMessage } = data;
        if (!res.ok || !userMessage || !assistantMessage) {
          throw new Error(data.error ?? `The reply failed (HTTP ${res.status}).`);
        }
        setSessionId(nextSessionId ?? null);
        setItems((prev) => [
          ...prev.filter((m) => m.id !== localId),
          userMessage,
          {
            ...assistantMessage,
            memoryUsed: data.memoryUsed,
            sources: data.sources,
          },
        ]);
        setPending(null);
      } catch (err) {
        setItems((prev) => prev.map((m) => (m.id === localId ? { ...m, failed: true } : m)));
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setSending(false);
      }
    },
    [isListening, sending, sessionId],
  );

  const retry = useCallback(() => {
    if (pending) void send(pending.text, { id: pending.localId });
  }, [pending, send]);

  return (
    <div className="app">
      <header className="app-header">
        <p className="app-title">
          Personal AI <span>· that remembers</span>
        </p>
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
            {sending && (
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
  );
}
