import { useState } from "react";
import { BoltIcon } from "./icons.js";

/**
 * Shown when the server rejects the stored credentials. Local deployments
 * without authentication never see it: `/api/auth/me` succeeds anonymously.
 */
export function LoginScreen({
  endpoint,
  onSubmit,
}: {
  endpoint: string;
  onSubmit: (token: string) => Promise<boolean>;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const ok = await onSubmit(value);
      if (!ok) setError("The server rejected this token.");
      else setToken("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="login-brand">
          <span className="login-mark">
            <BoltIcon size={20} />
          </span>
          <div>
            <h1>Kestrel</h1>
            <p>{endpoint.replace(/^https?:\/\//, "")}</p>
          </div>
        </div>

        <label className="field">
          <span>Access token</span>
          <input
            type="password"
            value={token}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="kst_…"
            onChange={(event) => {
              setToken(event.target.value);
              setError(undefined);
            }}
          />
        </label>
        {error && <p className="login-error">{error}</p>}

        <button type="submit" className="button primary login-submit" disabled={!token.trim() || busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <p className="login-hint">
          The token stays in this browser. Create one with <code>kestrel users create &lt;name&gt;</code> on the
          server, or use the operator token from <code>server.token</code>.
        </p>
      </form>
    </div>
  );
}
