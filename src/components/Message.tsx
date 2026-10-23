"use client";

import Markdown from "react-markdown";

/** The wire shape shared by /api/chat and /api/sessions. */
export type WireMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  failed?: boolean;
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
  return (
    <div className="msg msg-assistant">
      <div className="markdown">
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}
