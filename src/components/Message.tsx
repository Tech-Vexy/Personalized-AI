"use client";

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
    </div>
  );
}
