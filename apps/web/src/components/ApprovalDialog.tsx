import { useEffect } from "react";
import type { ApprovalRequest } from "@kestrel/protocol";
import { ShieldIcon } from "./icons.js";

export function ApprovalDialog({
  approval,
  onDecide,
}: {
  approval: ApprovalRequest;
  onDecide: (approved: boolean) => void | Promise<void>;
}) {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") void onDecide(false);
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void onDecide(true);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDecide]);

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="modal-icon">
          <ShieldIcon size={22} />
        </div>
        <h2 id="approval-title">Approve tool call</h2>
        <p className="modal-subtitle">
          Kestrel wants to run <code>{approval.call.name}</code>. Approve only if you trust this action in the current
          workspace.
        </p>
        <div className="modal-code">
          <div className="modal-code-label">arguments</div>
          <pre>{JSON.stringify(approval.call.arguments ?? {}, null, 2)}</pre>
        </div>
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={() => void onDecide(false)}>
            Decline <span className="kbd">Esc</span>
          </button>
          <button type="button" className="button primary" onClick={() => void onDecide(true)}>
            Approve <span className="kbd">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
