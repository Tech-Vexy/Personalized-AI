"use client";

import { useState } from "react";

/** One recalled memory's provenance, straight from the envelope's sources. */
export type EnvelopeSourceView = {
  session_id: number;
  date: string;
  taken: string;
  why_now: string;
};

/**
 * The thought-signature panel (spec.md > Components > Thought-signature
 * panel): visible proof of recall, rendered above the answer only when the
 * AI judged it worth showing. Collapsed by default — proof, not clutter.
 */
export default function ThoughtSignature({
  sources,
  onOpenVault,
}: {
  sources: EnvelopeSourceView[];
  onOpenVault?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  const label =
    sources.length === 1
      ? `Recalled from your ${sources[0].date} session`
      : `Recalled from ${sources.length} earlier sessions`;

  return (
    <div className="thought-sig">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="thought-sig-dot" aria-hidden="true" />
        <span>{label}</span>
        <span className="thought-sig-chev" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="thought-sig-body">
          <ul>
            {sources.map((s, i) => (
              <li key={`${s.session_id}-${i}`}>
                <strong>{s.date}</strong> — took: {s.taken}
                {s.why_now ? ` · why now: ${s.why_now}` : ""}
              </li>
            ))}
          </ul>
          {onOpenVault && (
            <div className="thought-sig-footer">
              <button
                type="button"
                className="thought-sig-vault-btn"
                onClick={onOpenVault}
              >
                🧠 Open Memory Vault →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}