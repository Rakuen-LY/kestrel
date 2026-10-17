import { useState } from "react";
import type { ChatMessage, ToolCall, ToolResult } from "@kestrel/protocol";
import { imageSrc } from "../images.js";
import { Markdown } from "./Markdown.js";
import { ToolCallCard } from "./ToolCall.js";
import { CheckIcon, ChevronIcon, CopyIcon } from "./icons.js";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : clock.format(date);
}

export function MessageBubble({
  message,
  calls = [],
  results = {},
  streaming,
}: {
  message: ChatMessage;
  calls?: ToolCall[];
  results?: Record<string, ToolResult>;
  streaming?: boolean;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [copied, setCopied] = useState(false);
  if (message.role === "tool") return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <article className={`message ${message.role}${streaming ? " streaming" : ""}`}>
      <div className="avatar" aria-hidden="true">
        {message.role === "user" ? "you" : "K"}
      </div>
      <div className="message-body">
        <header className="message-head">
          <span className="message-role">{message.role === "user" ? "You" : "Kestrel"}</span>
          <span className="message-time">{shortTime(message.createdAt)}</span>
          {message.model && <span className="badge ghost">{message.model}</span>}
          <button
            type="button"
            className="icon-button subtle message-copy"
            onClick={() => void copy()}
            aria-label="Copy message"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </header>
        {message.reasoning && (
          <div className="reasoning">
            <button type="button" className="reasoning-toggle" onClick={() => setShowReasoning((value) => !value)}>
              <ChevronIcon size={13} className={showReasoning ? "open" : ""} />
              Reasoning
            </button>
            {showReasoning && <div className="reasoning-body">{message.reasoning}</div>}
          </div>
        )}
        {calls.length > 0 && (
          <div className="tool-stack">
            {calls.map((call) => (
              <ToolCallCard key={call.id} call={call} result={results[call.id]} />
            ))}
          </div>
        )}
        {message.images?.length ? (
          <div className={`message-images${message.images.length === 1 ? " single" : ""}`}>
            {message.images.map((image, index) => (
              <a
                key={`${image.mimeType}-${index}`}
                href={imageSrc(image)}
                target="_blank"
                rel="noreferrer"
                title={image.name ?? "Open image"}
              >
                <img src={imageSrc(image)} alt={image.name ?? `attachment ${index + 1}`} loading="lazy" />
              </a>
            ))}
          </div>
        ) : null}
        {message.content ? (
          message.role === "user" ? (
            <div className="user-text">{message.content}</div>
          ) : (
            <Markdown>{message.content}</Markdown>
          )
        ) : message.images?.length ? null : (
          <div className="typing" aria-label="Kestrel is thinking">
            <span />
            <span />
            <span />
          </div>
        )}
        {streaming && message.content && <span className="caret" />}
      </div>
    </article>
  );
}
