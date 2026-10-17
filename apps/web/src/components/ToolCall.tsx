import { useState } from "react";
import type { ToolCall, ToolResult } from "@kestrel/protocol";
import { ChevronIcon, TerminalIcon } from "./icons.js";

function summarize(call: ToolCall): string {
  const args = call.arguments ?? {};
  const primary =
    (args.path as string | undefined) ??
    (args.command as string | undefined) ??
    (args.pattern as string | undefined) ??
    (args.url as string | undefined) ??
    (args.query as string | undefined) ??
    (args.summary as string | undefined);
  if (typeof primary === "string" && primary.trim()) {
    return primary.replace(/\s+/g, " ").slice(0, 120);
  }
  const keys = Object.keys(args);
  return keys.length ? keys.slice(0, 3).join(", ") : "no arguments";
}

export function ToolCallCard({
  call,
  result,
  pending,
}: {
  call: ToolCall;
  result?: ToolResult;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const failed = result ? !result.ok : false;
  const output = result?.content ?? "";
  const lines = output.split("\n");
  const preview = lines.slice(0, 6).join("\n");
  const long = lines.length > 6 || output.length > 600;

  return (
    <div className={`tool-card${failed ? " failed" : ""}${pending ? " pending" : ""}`}>
      <button type="button" className="tool-card-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-icon${pending ? " pulsing" : ""}`}>
          <TerminalIcon size={14} />
        </span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{summarize(call)}</span>
        {pending && <span className="tool-state">running…</span>}
        {result && (
          <span className={`tool-state${failed ? " error" : ""}`}>
            {failed ? "failed" : `${result.durationMs ?? 0}ms`}
          </span>
        )}
        <ChevronIcon size={14} className={`tool-chevron${open ? " open" : ""}`} />
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">arguments</div>
          <pre className="tool-pre">{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
          {result && (
            <>
              <div className="tool-section-label">result</div>
              <pre className="tool-pre">{output || "(empty)"}</pre>
            </>
          )}
        </div>
      )}
      {!open && result && preview && (
        <pre className="tool-preview">{preview}</pre>
      )}
      {!open && !result && pending && <div className="tool-preview dim">Waiting for result…</div>}
      {!open && long && <div className="tool-more">click to expand</div>}
    </div>
  );
}
