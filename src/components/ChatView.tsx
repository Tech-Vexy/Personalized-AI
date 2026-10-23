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

export default function ChatView() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [items, setItems] = useState<WireMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** The message held in client state until an answer exists (spec.md > Error & retry). */
  const [pending, setPending] = useState<{ text: string; localId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, sending]);

  // The input grows with its content, up to a cap.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const send = useCallback(
    async (text: string, existing?: { id: number }) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
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
    [sending, sessionId],
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
              <div className="typing" role="status" aria-label="The assistant is thinking">
                <span />
                <span />
                <span />
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
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder="Write a message…"
            aria-label="Message"
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
    </div>
  );
}
