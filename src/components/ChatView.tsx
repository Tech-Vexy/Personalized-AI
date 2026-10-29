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

type MemoryItem = {
  id: number;
  content: string;
  sessionId: number;
  sessionTitle: string;
  createdAt: string;
  date: string;
};

// Web Speech API interface definitions
interface SpeechRecognitionEventLike {
  resultIndex?: number;
  results: {
    length: number;
    [index: number]: {
      isFinal?: boolean;
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

  // Memory Vault state (Memory is the commodity)
  const [vaultOpen, setVaultOpen] = useState(false);
  const [memoriesList, setMemoriesList] = useState<MemoryItem[]>([]);
  const [vaultFilter, setVaultFilter] = useState("");
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<number | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);

  // Cloud Sync & Database state
  const [syncStatus, setSyncStatus] = useState<{
    configured: boolean;
    dbUrl: string | null;
    lastSyncAt: string | null;
  } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Multimodal image attachment state
  const [attachedImage, setAttachedImage] = useState<{
    dataUri: string;
    name: string;
  } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** The message held in client state until an answer exists (spec.md > Error & retry). */
  const [pending, setPending] = useState<{ text: string; localId: number; imageUrl?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseInputRef = useRef("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

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

  // Fetch full memory vault
  const fetchMemories = useCallback(async () => {
    try {
      const res = await fetch("/api/memories");
      if (!res.ok) return;
      const data = (await res.json()) as { memories?: MemoryItem[]; count?: number };
      if (Array.isArray(data.memories)) {
        setMemoriesList(data.memories);
      }
    } catch (e) {
      console.error("[memories] failed to load vault:", e);
    }
  }, []);

  useEffect(() => {
    void fetchMemories();
  }, [fetchMemories]);

  // Close Memory Vault on Escape key
  useEffect(() => {
    if (!vaultOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVaultOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [vaultOpen]);

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

  const stopDictation = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    setIsListening(false);
  }, []);

  const handleNewChat = useCallback(() => {
    if (sending) return;
    if (isListening) {
      stopDictation();
    }
    setSessionId(null);
    setItems([]);
    setInput("");
    setAttachedImage(null);
    setIsDraggingOver(false);
    setPending(null);
    setError(null);
    setMicNotice(null);
    taRef.current?.focus();
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, [isListening, sending, stopDictation]);

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

  const handleAddMemory = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = newMemoryContent.trim();
      if (!text || isSavingMemory) return;

      setIsSavingMemory(true);
      setMemoryNotice(null);
      try {
        const res = await fetch("/api/memories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text, sessionId }),
        });
        if (!res.ok) throw new Error("Could not save memory to vault");
        const data = (await res.json()) as { success: boolean; memory?: MemoryItem };
        if (data.memory) {
          setMemoriesList((prev) => [data.memory!, ...prev]);
          setNewMemoryContent("");
          setMemoryNotice("Memory permanently stored in vault.");
          setTimeout(() => setMemoryNotice(null), 3000);
        }
      } catch (err) {
        setMemoryNotice(err instanceof Error ? err.message : "Failed to store memory");
      } finally {
        setIsSavingMemory(false);
      }
    },
    [isSavingMemory, newMemoryContent, sessionId],
  );

  const handleDeleteMemory = useCallback(
    async (id: number) => {
      if (deletingMemoryId === id) return;
      setDeletingMemoryId(id);
      try {
        const res = await fetch(`/api/memories?id=${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Could not delete memory");
        setMemoriesList((prev) => prev.filter((m) => m.id !== id));
      } catch (err) {
        console.error("Failed to delete memory:", err);
      } finally {
        setDeletingMemoryId(null);
      }
    },
    [deletingMemoryId],
  );

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync");
      if (res.ok) {
        const data = (await res.json()) as {
          configured: boolean;
          dbUrl: string | null;
          lastSyncAt: string | null;
        };
        setSyncStatus(data);
      }
    } catch (e) {
      console.warn("Failed to fetch sync status", e);
    }
  }, []);

  useEffect(() => {
    if (vaultOpen) {
      void fetchSyncStatus();
    }
  }, [vaultOpen, fetchSyncStatus]);

  const handleTriggerSync = useCallback(async () => {
    setIsSyncing(true);
    setMemoryNotice(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
      const data = (await res.json()) as {
        success: boolean;
        pushed?: { memories: number };
        pulled?: { memories: number };
        currentStatus?: { configured: boolean; dbUrl: string | null; lastSyncAt: string | null };
        error?: string;
      };
      if (data.success) {
        setMemoryNotice(
          `Sync complete: Pushed ${data.pushed?.memories ?? 0} memories, Pulled ${data.pulled?.memories ?? 0} memories.`,
        );
        if (data.currentStatus) setSyncStatus(data.currentStatus);
        void fetchMemories();
        void fetchSessions();
      } else {
        setMemoryNotice(data.error ?? "Sync failed");
      }
    } catch (e) {
      setMemoryNotice(e instanceof Error ? e.message : "Failed to sync with Turso");
    } finally {
      setIsSyncing(false);
      setTimeout(() => setMemoryNotice(null), 5000);
    }
  }, [fetchMemories, fetchSessions]);

  const handleImportBackup = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const snapshot = JSON.parse(text);
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import", snapshot }),
        });
        const data = (await res.json()) as {
          success: boolean;
          imported?: { memories: number; sessions: number };
          error?: string;
        };
        if (data.success) {
          setMemoryNotice(
            `Backup restored! Imported ${data.imported?.memories ?? 0} memories and ${data.imported?.sessions ?? 0} sessions.`,
          );
          void fetchMemories();
          void fetchSessions();
          void fetchSyncStatus();
        } else {
          setMemoryNotice(data.error ?? "Failed to restore backup");
        }
      } catch (err) {
        setMemoryNotice(
          `Invalid backup file: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        e.target.value = "";
        setTimeout(() => setMemoryNotice(null), 5000);
      }
    },
    [fetchMemories, fetchSessions, fetchSyncStatus],
  );

  const toggleMic = useCallback(async () => {
    if (isListening) {
      stopDictation();
      return;
    }

    baseInputRef.current = input.trim();
    setIsListening(true);
    setMicNotice(null);

    // 1. Audio recording stream for Deepgram Nova-2 STT (works across all browsers)
    let mediaRecorderActive = false;
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          const audioBlob = new Blob(audioChunksRef.current, {
            type: mediaRecorder.mimeType || "audio/webm",
          });
          if (audioBlob.size > 1000) {
            try {
              const res = await fetch("/api/stt", {
                method: "POST",
                headers: { "Content-Type": audioBlob.type },
                body: audioBlob,
              });
              if (res.ok) {
                const data = (await res.json()) as { transcript?: string };
                if (data.transcript) {
                  const base = baseInputRef.current;
                  setInput(base ? `${base} ${data.transcript}` : data.transcript);
                }
              }
            } catch (err) {
              console.log("[stt] Deepgram fallback to Web Speech:", err);
            }
          }
        };

        mediaRecorder.start();
        mediaRecorderRef.current = mediaRecorder;
        mediaRecorderActive = true;
      } catch (err) {
        console.warn("[stt] MediaRecorder audio access unavailable:", err);
      }
    }

    // 2. Web Speech API for immediate live interim hypothesis display (fixed duplication bug)
    const SpeechAPI =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;

    if (SpeechAPI) {
      try {
        const recognition = new SpeechAPI();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onresult = (event: SpeechRecognitionEventLike) => {
          let accumulated = "";
          for (let i = 0; i < (event.results.length || 0); i++) {
            const item = event.results[i];
            if (item && item[0]?.transcript) {
              accumulated += item[0].transcript;
            }
          }
          const spoken = accumulated.trim();
          if (spoken) {
            const base = baseInputRef.current;
            setInput(base ? `${base} ${spoken}` : spoken);
          }
        };

        recognition.onerror = () => {
          if (!mediaRecorderActive) setIsListening(false);
        };

        recognition.onend = () => {
          if (!mediaRecorderActive) setIsListening(false);
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch {
        if (!mediaRecorderActive) setIsListening(false);
      }
    } else if (!mediaRecorderActive) {
      setIsListening(false);
      setMicNotice(
        "Microphone input requires microphone permission or Google Chrome / Edge.",
      );
      setTimeout(() => setMicNotice(null), 5000);
    }
  }, [input, isListening, stopDictation]);

  const handleImageFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setMicNotice("Please attach an image file (PNG, JPG, WebP, GIF).");
      setTimeout(() => setMicNotice(null), 4000);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMicNotice("Image is too large (max 10MB).");
      setTimeout(() => setMicNotice(null), 4000);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setAttachedImage({
          dataUri: reader.result,
          name: file.name || "Attached image",
        });
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const clipboardItems = e.clipboardData?.items;
    if (!clipboardItems) return;
    for (let i = 0; i < clipboardItems.length; i++) {
      if (clipboardItems[i].type.startsWith("image/")) {
        const file = clipboardItems[i].getAsFile();
        if (file) {
          e.preventDefault();
          handleImageFile(file);
          return;
        }
      }
    }
  }, [handleImageFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      handleImageFile(file);
    }
  }, [handleImageFile]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImageFile(file);
    }
    e.target.value = "";
  }, [handleImageFile]);

  const send = useCallback(
    async (text: string, existing?: { id: number; imageUrl?: string }) => {
      const currentImage = existing?.imageUrl ?? attachedImage?.dataUri;
      const trimmed = text.trim() || (currentImage ? "Analyze this image in detail." : "");
      if ((!trimmed && !currentImage) || sending) return;

      if (isListening) {
        stopDictation();
      }

      const userLocalId = existing?.id ?? -Date.now();
      const assistantLocalId = -Date.now() - 1;

      if (existing) {
        setItems((prev) => prev.map((m) => (m.id === userLocalId ? { ...m, failed: false } : m)));
      } else {
        setItems((prev) => [
          ...prev,
          {
            id: userLocalId,
            role: "user",
            content: trimmed,
            imageUrl: currentImage,
            createdAt: new Date().toISOString(),
          },
        ]);
        setInput("");
        setAttachedImage(null);
      }

      setPending({ text: trimmed, localId: userLocalId, imageUrl: currentImage });
      setError(null);
      setSending(true);
      setStreamingHasContent(false);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, sessionId, stream: true, imageUrl: currentImage }),
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
                  setTimeout(() => {
                    void fetchMemories();
                  }, 2500);
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
          setTimeout(() => {
            void fetchMemories();
          }, 2500);
        }
      } catch (err) {
        setItems((prev) => prev.map((m) => (m.id === userLocalId ? { ...m, failed: true } : m)));
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setSending(false);
      }
    },
    [attachedImage, fetchMemories, fetchSessions, isListening, sending, sessionId, stopDictation],
  );

  const retry = useCallback(() => {
    if (pending) void send(pending.text, { id: pending.localId, imageUrl: pending.imageUrl });
  }, [pending, send]);

  const filteredMemories = memoriesList.filter((m) => {
    if (!vaultFilter.trim()) return true;
    const q = vaultFilter.toLowerCase();
    return (
      m.content.toLowerCase().includes(q) ||
      m.sessionTitle.toLowerCase().includes(q) ||
      m.date.includes(q)
    );
  });

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

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-vault-btn"
            onClick={() => {
              setVaultOpen(true);
              if (typeof window !== "undefined" && window.innerWidth < 768) {
                setSidebarOpen(false);
              }
            }}
            title="Open Memory Vault"
          >
            <div className="sidebar-vault-left">
              <span className="sidebar-vault-icon" aria-hidden="true">🧠</span>
              <div className="sidebar-vault-info">
                <span className="sidebar-vault-title">Memory Vault</span>
                <span className="sidebar-vault-count">{memoriesList.length} memories stored</span>
              </div>
            </div>
            <span className="sidebar-vault-arrow" aria-hidden="true">→</span>
          </button>
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

          <div className="app-header-right">
            <button
              type="button"
              className="vault-header-btn"
              onClick={() => setVaultOpen(true)}
              title="Open Memory Vault (Durable Long-term Memory)"
            >
              <span className="vault-header-btn-icon" aria-hidden="true">🧠</span>
              <span className="vault-header-btn-label">Memory Vault</span>
              <span className="vault-header-btn-count">{memoriesList.length}</span>
            </button>

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
          </div>
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
                  onOpenVault={() => setVaultOpen(true)}
                />
              ))}
              {sending && !streamingHasContent && (
                <div
                  className="thinking-card"
                  role="status"
                  aria-live="polite"
                  aria-label={`The assistant is thinking, elapsed ${elapsedSeconds} seconds`}
                >
                  <div className="thinking-orb">
                    <span className="orb-ring" />
                    <span className="orb-core" />
                  </div>
                  <div className="thinking-content">
                    <div className="thinking-title-row">
                      <span className="thinking-title">Synthesizing response…</span>
                      <span className="thinking-timer">{elapsedSeconds}s</span>
                    </div>
                    <div className="thinking-shimmer" />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        <footer
          className={`composer ${isDraggingOver ? "composer-drag-over" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingOver && (
            <div className="composer-drop-overlay">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>Drop image to analyze with Nemotron 3.5 Super VL</span>
            </div>
          )}

          {attachedImage && (
            <div className="composer-attached-preview">
              <div className="composer-attached-thumb-wrap">
                <img
                  src={attachedImage.dataUri}
                  alt={attachedImage.name}
                  className="composer-attached-thumb"
                />
              </div>
              <div className="composer-attached-info">
                <span className="composer-attached-name" title={attachedImage.name}>
                  {attachedImage.name}
                </span>
                <span className="composer-attached-badge">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  Nemotron 3.5 Super VL
                </span>
              </div>
              <button
                type="button"
                className="composer-attached-remove"
                onClick={() => setAttachedImage(null)}
                aria-label="Remove image"
                title="Remove attached image"
              >
                ✕
              </button>
            </div>
          )}

          {isListening && (
            <div className="listening-banner" role="status" aria-live="polite">
              <div className="listening-waveform" aria-hidden="true">
                <span className="l-bar bar-1" />
                <span className="l-bar bar-2" />
                <span className="l-bar bar-3" />
                <span className="l-bar bar-4" />
                <span className="l-bar bar-5" />
                <span className="l-bar bar-6" />
              </div>
              <span className="listening-banner-text">Listening with Deepgram Nova-2… speak now</span>
            </div>
          )}

          <form
            className="composer-inner"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <div className="composer-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: "none" }}
                onChange={handleFileInputChange}
              />
              <button
                type="button"
                className={`composer-attach-btn ${attachedImage ? "has-image" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                title="Attach image (PNG, JPG, WebP) or paste with Ctrl+V"
                aria-label="Attach image"
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
                  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                </svg>
              </button>

              <div className="composer-mic-wrapper">
                {isListening && <span className="mic-ripple" />}
                {isListening && <span className="mic-ripple ring-2" />}
                <button
                  type="button"
                  className={`composer-mic ${isListening ? "listening" : ""}`}
                  onClick={toggleMic}
                  disabled={sending}
                  title={
                    isListening
                      ? "Listening with Deepgram… click to stop"
                      : "Dictate with microphone (Deepgram Nova-2)"
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
              </div>
            </div>

            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder={
                isListening
                  ? "Listening… speak now"
                  : attachedImage
                  ? "Ask about this image (or press Enter to analyze)…"
                  : "Write a message or paste an image (Ctrl+V)…"
              }
              aria-label="Message"
              disabled={sending}
              onPaste={handlePaste}
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
              disabled={sending || (input.trim() === "" && !attachedImage)}
            >
              Send
            </button>
          </form>
          {micNotice && <p className="composer-notice">{micNotice}</p>}
          <p className="composer-hint">Enter to send · Shift+Enter for newline · Paste (Ctrl+V) or drop images</p>
        </footer>
      </div>

      {/* Memory Vault Modal */}
      {vaultOpen && (
        <div
          className="vault-modal-overlay"
          onClick={() => setVaultOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="vault-modal-title"
        >
          <div className="vault-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="vault-header">
              <div className="vault-title-wrap">
                <div className="vault-icon-badge" aria-hidden="true">🧠</div>
                <div>
                  <h2 id="vault-modal-title" className="vault-title">Memory Vault</h2>
                  <p className="vault-subtitle">
                    The AI&apos;s persistent commodity. Memories stored here persist across conversations and are recalled dynamically.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="vault-close-btn"
                onClick={() => setVaultOpen(false)}
                aria-label="Close Memory Vault"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Cloud Sync & Database Manager */}
            <div className="vault-sync-bar">
              <div className="vault-sync-status">
                <span className={`sync-status-dot ${syncStatus?.configured ? "active" : ""}`} />
                <div className="sync-status-details">
                  <span className="sync-status-title">
                    {syncStatus?.configured ? "Turso Cloud Sync Active" : "Local SQLite Kernel"}
                  </span>
                  <span className="sync-status-sub">
                    {syncStatus?.configured
                      ? syncStatus.lastSyncAt
                        ? `Last synced ${formatSessionDate(syncStatus.lastSyncAt)}`
                        : "Ready to sync with Turso"
                      : "Local-first on disk · Set TURSO_DATABASE_URL to sync across devices"}
                  </span>
                </div>
              </div>

              <div className="vault-sync-actions">
                {syncStatus?.configured && (
                  <button
                    type="button"
                    className="vault-action-btn sync-btn"
                    onClick={handleTriggerSync}
                    disabled={isSyncing}
                  >
                    {isSyncing ? "Syncing…" : "↻ Sync Cloud"}
                  </button>
                )}
                <a
                  href="/api/sync?export=true"
                  download
                  className="vault-action-btn export-btn"
                  title="Download full SQLite snapshot as JSON"
                >
                  ⭳ Export
                </a>
                <label className="vault-action-btn import-btn" title="Restore database from JSON snapshot">
                  ⭱ Restore
                  <input
                    type="file"
                    accept=".json"
                    style={{ display: "none" }}
                    onChange={handleImportBackup}
                  />
                </label>
              </div>
            </div>

            {/* Quick add form */}
            <form className="vault-add-form" onSubmit={handleAddMemory}>
              <div className="vault-add-input-wrapper">
                <input
                  type="text"
                  className="vault-add-input"
                  placeholder="Teach AI a permanent fact (e.g. 'I run a company called Lumen' or 'I prefer concise bullet points')…"
                  value={newMemoryContent}
                  onChange={(e) => setNewMemoryContent(e.target.value)}
                  disabled={isSavingMemory}
                />
                <button
                  type="submit"
                  className="vault-add-btn"
                  disabled={isSavingMemory || !newMemoryContent.trim()}
                >
                  {isSavingMemory ? "Storing…" : "+ Store Memory"}
                </button>
              </div>
              {memoryNotice && <p className="vault-notice">{memoryNotice}</p>}
            </form>

            {/* Search & Filter Bar */}
            <div className="vault-search-row">
              <div className="vault-search-input-wrap">
                <svg className="vault-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  className="vault-search-input"
                  placeholder="Search recalled memories or session origins…"
                  value={vaultFilter}
                  onChange={(e) => setVaultFilter(e.target.value)}
                />
                {vaultFilter && (
                  <button
                    type="button"
                    className="vault-search-clear"
                    onClick={() => setVaultFilter("")}
                    aria-label="Clear filter"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="vault-stats-wrap">
                <span className="vault-hybrid-badge" title="Hybrid Reciprocal Rank Fusion: FTS5 BM25 + 128-D Semantic Vectors">
                  ⚡ Hybrid Recall
                </span>
                <span className="vault-count-badge">
                  {filteredMemories.length} {filteredMemories.length === 1 ? "memory" : "memories"}
                </span>
              </div>
            </div>

            {/* Memory List */}
            <div className="vault-list">
              {filteredMemories.length === 0 ? (
                <div className="vault-empty">
                  {vaultFilter ? (
                    <p>No memories match &ldquo;{vaultFilter}&rdquo;.</p>
                  ) : (
                    <>
                      <p className="vault-empty-title">Your Memory Vault is empty</p>
                      <p className="vault-empty-sub">
                        Have a conversation with your AI or type a durable fact above to teach it.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                filteredMemories.map((m) => (
                  <div key={m.id} className="vault-card">
                    <div className="vault-card-body">
                      <p className="vault-card-text">{m.content}</p>
                      <div className="vault-card-meta">
                        <span className="vault-tag-session" title={`Source session: ${m.sessionTitle}`}>
                          <span className="tag-dot" />
                          {m.sessionTitle}
                        </span>
                        <span className="vault-tag-date">{m.date}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="vault-card-delete-btn"
                      onClick={() => handleDeleteMemory(m.id)}
                      disabled={deletingMemoryId === m.id}
                      title="Forget this memory"
                      aria-label="Delete memory"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
