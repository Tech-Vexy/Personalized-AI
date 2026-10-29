"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import ThoughtSignature, { type EnvelopeSourceView } from "./ThoughtSignature";

/** The wire shape shared by /api/chat and /api/sessions. */
export type WireMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  imageUrl?: string;
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
  onOpenVault,
}: {
  message: WireMessage;
  failed?: boolean;
  failReason?: string;
  onRetry?: () => void;
  onOpenVault?: () => void;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasCachedAudio, setHasCachedAudio] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioBlobUrlRef = useRef<string | null>(null);

  // Clean up object URLs and audio only on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current);
        audioBlobUrlRef.current = null;
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const fallbackToSpeechSynthesis = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setIsPlaying(false);
      setIsPaused(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdown(text));
    utterance.onend = () => {
      setIsPlaying(false);
      setIsPaused(false);
    };
    utterance.onerror = () => {
      setIsPlaying(false);
      setIsPaused(false);
    };
    window.speechSynthesis.speak(utterance);
    setIsPlaying(true);
    setIsPaused(false);
  };

  const handleToggleSpeech = async () => {
    // 1. If currently playing -> PAUSE (zero network call, zero re-generation cost)
    if (isPlaying) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.pause();
      }
      setIsPlaying(false);
      setIsPaused(true);
      return;
    }

    // 2. If paused -> RESUME immediately (zero network call, zero re-generation cost)
    if (isPaused && audioRef.current) {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
        setIsPaused(false);
        return;
      } catch (err) {
        console.warn("[tts] failed to resume cached audio element:", err);
      }
    }

    // 3. If audio was already generated & cached in memory -> REPLAY (zero network call)
    if (audioBlobUrlRef.current) {
      try {
        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio(audioBlobUrlRef.current);
          audioRef.current = audio;
          audio.onended = () => {
            setIsPlaying(false);
            setIsPaused(false);
          };
          audio.onerror = () => {
            setIsPlaying(false);
            setIsPaused(false);
            fallbackToSpeechSynthesis(message.content);
          };
        }
        audio.currentTime = 0;
        await audio.play();
        setIsPlaying(true);
        setIsPaused(false);
        return;
      } catch (err) {
        console.warn("[tts] failed to replay cached audio blob:", err);
      }
    }

    // 4. Initial play -> fetch once from /api/tts (server also checks its disk cache)
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
        audioBlobUrlRef.current = url;
        setHasCachedAudio(true);

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          setIsPlaying(false);
          setIsPaused(false);
        };
        audio.onerror = () => {
          setIsPlaying(false);
          setIsPaused(false);
          fallbackToSpeechSynthesis(message.content);
        };

        await audio.play();
        setIsPlaying(true);
        setIsPaused(false);
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
        {message.imageUrl && (
          <div className="msg-user-image-wrap">
            <img
              src={message.imageUrl}
              alt="Attached visual context"
              className="msg-user-image"
              onClick={() => setShowLightbox(true)}
              title="Click to view full image"
            />
          </div>
        )}
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
        {showLightbox && message.imageUrl && (
          <div
            className="image-lightbox-overlay"
            onClick={() => setShowLightbox(false)}
            role="dialog"
            aria-modal="true"
          >
            <div className="image-lightbox-content" onClick={(e) => e.stopPropagation()}>
              <img src={message.imageUrl} alt="Enlarged view" className="image-lightbox-img" />
              <button
                type="button"
                className="image-lightbox-close"
                onClick={() => setShowLightbox(false)}
                aria-label="Close enlarged view"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const showPanel =
    message.memoryUsed === true && !!message.sources && message.sources.length > 0;

  return (
    <div className="msg msg-assistant">
      {showPanel && <ThoughtSignature sources={message.sources!} onOpenVault={onOpenVault} />}
      <div className="markdown">
        <Markdown>{message.content}</Markdown>
      </div>
      <div className="msg-actions">
        <button
          type="button"
          className={`msg-action-btn ${isPlaying ? "playing" : ""} ${isPaused ? "paused" : ""} ${isLoadingAudio ? "loading" : ""}`}
          onClick={handleToggleSpeech}
          disabled={isLoadingAudio}
          title={
            isPlaying
              ? "Pause speech"
              : isPaused
              ? "Resume speech (cached)"
              : hasCachedAudio
              ? "Replay speech (cached)"
              : "Read aloud with Gemma (Cartesia Sonic)"
          }
          aria-label={isPlaying ? "Pause speech" : isPaused ? "Resume speech" : "Read aloud with Gemma"}
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
              <span className="tts-playing-text">Pause (Gemma)</span>
              <span className="tts-stop-icon" title="Pause playback">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="5" y="4" width="4" height="16" rx="1" />
                  <rect x="15" y="4" width="4" height="16" rx="1" />
                </svg>
              </span>
            </div>
          ) : isPaused ? (
            <span className="tts-idle-indicator">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>Resume (Gemma)</span>
            </span>
          ) : hasCachedAudio ? (
            <span className="tts-idle-indicator">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>Replay (Gemma)</span>
            </span>
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
