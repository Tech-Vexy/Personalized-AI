"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Message, { type WireMessage } from "./Message";

type OnboardingProps = {
  onComplete: () => void;
};

type ChatResponse = {
  sessionId: number;
  userMessage: WireMessage;
  assistantMessage: WireMessage;
  onboardingComplete?: boolean;
};

const INITIAL_MESSAGE: WireMessage = {
  id: 0,
  role: "assistant",
  content:
    "Welcome. I am your thinking companion. Before we begin working together, tell me a little about yourself — what should I call you, and what are you currently building or thinking through?",
  createdAt: new Date().toISOString(),
};

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [items, setItems] = useState<WireMessage[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, sending]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      const localId = -Date.now();
      setItems((prev) => [
        ...prev,
        { id: localId, role: "user", content: trimmed, createdAt: new Date().toISOString() },
      ]);
      setInput("");
      setError(null);
      setSending(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, sessionId, onboarding: true }),
        });

        const data = (await res.json().catch(() => ({}))) as Partial<ChatResponse> & {
          error?: string;
        };

        const { sessionId: nextSessionId, userMessage, assistantMessage, onboardingComplete } = data;
        if (!res.ok || !userMessage || !assistantMessage) {
          throw new Error(data.error ?? `Turn failed (HTTP ${res.status})`);
        }

        setSessionId(nextSessionId ?? null);
        setItems((prev) => [
          ...prev.filter((m) => m.id !== localId),
          userMessage,
          assistantMessage,
        ]);

        if (onboardingComplete) {
          setIsDone(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send message");
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId],
  );

  return (
    <div className="app">
      <header className="app-header">
        <p className="app-title">
          Personal AI <span>· onboarding</span>
        </p>
        <button
          type="button"
          className="skip-btn"
          onClick={() => {
            void fetch("/api/profile", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: "onboarding_done", value: "true" }),
            });
            onComplete();
          }}
          title="Skip onboarding and enter chat"
        >
          Skip to chat →
        </button>
      </header>

      <main className="chat">
        <div className="chat-column">
          {items.map((m) => (
            <Message key={m.id} message={m} />
          ))}

          {sending && (
            <div className="typing" role="status" aria-label="The assistant is thinking">
              <span />
              <span />
              <span />
            </div>
          )}

          {error && <p className="msg-failed">{error}</p>}

          {isDone && (
            <div className="onboarding-done-banner">
              <p>Foundations set. The facts you shared are saved into long-term memory.</p>
              <button
                className="onboarding-enter-btn"
                type="button"
                onClick={onComplete}
              >
                Enter Workspace
              </button>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </main>

      {!isDone && (
        <footer className="composer">
          <form
            className="composer-inner"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder="Answer conversationally…"
              aria-label="Onboarding message"
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
          <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
        </footer>
      )}
    </div>
  );
}
