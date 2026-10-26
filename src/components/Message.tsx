"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import ThoughtSignature, { type EnvelopeSourceView } from "./ThoughtSignature";

/** The wire shape shared by /api/chat and /api/sessions. */
export type WireMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  failed?: boolean;
  /** Present on assistant replies when the AI drew on long-term memory. */
  memoryUsed?: boolean;
  sources?: EnvelopeSourceView[];
};

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~`>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function Message({
  message,
  failed,
  failReason,
  onRetry,
}: {
  message: WireMessage;
  failed?: boolean;
  failReason?: string;
  onRetry?: () => void;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop audio if message unmounts
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const fallbackToSpeechSynthesis = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setIsPlaying(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdown(text));
    utterance.onend = () => setIsPlaying(false);
    utterance.onerror = () => setIsPlaying(false);
    window.speechSynthesis.speak(utterance);
    setIsPlaying(true);
  };

  const handleToggleSpeech = async () => {
    if (isPlaying) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      setIsPlaying(false);
      return;
    }

    if (!message.content.trim()) return;

    setIsLoadingAudio(true);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message.content }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          setIsPlaying(false);
          fallbackToSpeechSynthesis(message.content);
        };
        await audio.play();
        setIsPlaying(true);
      } else {
        fallbackToSpeechSynthesis(message.content);
      }
    } catch {
      fallbackToSpeechSynthesis(message.content);
    } finally {
      setIsLoadingAudio(false);
    }
  };

  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <p className="msg-user-text">{message.content}</p>
        {failed && (
          <div className="msg-failed">
            <span>{failReason ?? "Not delivered."}</span>
            {onRetry && (
              <button type="button" className="msg-retry" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const showPanel =
    message.memoryUsed === true && !!message.sources && message.sources.length > 0;

  return (
    <div className="msg msg-assistant">
      {showPanel && <ThoughtSignature sources={message.sources!} />}
      <div className="markdown">
        <Markdown>{message.content}</Markdown>
      </div>
      <div className="msg-actions">
        <button
          type="button"
          className={`msg-action-btn ${isPlaying ? "playing" : ""} ${isLoadingAudio ? "loading" : ""}`}
          onClick={handleToggleSpeech}
          disabled={isLoadingAudio}
          title={isPlaying ? "Stop speech" : "Read aloud with Gemma (Cartesia Sonic)"}
          aria-label={isPlaying ? "Stop speech" : "Read aloud with Gemma"}
        >
          {isLoadingAudio ? (
            <span className="tts-loading-indicator">
              <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
              </svg>
              <span>Generating voice…</span>
            </span>
          ) : isPlaying ? (
            <div className="tts-playing-indicator">
              <div className="audio-waveform-bars" aria-label="Audio waveform visualizer">
                <span className="wave-bar bar-1" />
                <span className="wave-bar bar-2" />
                <span className="wave-bar bar-3" />
                <span className="wave-bar bar-4" />
                <span className="wave-bar bar-5" />
              </div>
              <span className="tts-playing-text">Speaking (Gemma)</span>
              <span className="tts-stop-icon" title="Stop playback">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </span>
            </div>
          ) : (
            <span className="tts-idle-indicator">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              <span>Listen (Gemma)</span>
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
