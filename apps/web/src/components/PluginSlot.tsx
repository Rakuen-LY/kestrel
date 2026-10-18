import { useEffect, useRef, useState } from "react";
import type { KestrelApi } from "../api.js";
import { themeVariables, type LoadedExtension, type SlotName } from "../extensions.js";

export function PluginSlot({
  slot,
  extensions,
  api,
  sessionId,
}: {
  slot: SlotName;
  extensions: LoadedExtension[];
  api: KestrelApi;
  sessionId?: string;
}) {
  const matching = extensions
    .filter((extension) => extension.slot === slot)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  return (
    <>
      {matching.map((extension) => (
        <PluginFrame
          key={`${extension.plugin.id}:${extension.id}:${sessionId ?? ""}`}
          extension={extension}
          api={api}
          sessionId={sessionId}
        />
      ))}
    </>
  );
}

/**
 * One contribution, one iframe. The frame has an opaque origin and talks to
 * the console over postMessage: it can render its own DOM, but API calls are
 * proxied with the console's token and never see it.
 */
function PluginFrame({
  extension,
  api,
  sessionId,
}: {
  extension: LoadedExtension;
  api: KestrelApi;
  sessionId?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let mounted = false;

    const send = (message: unknown): void => {
      element.contentWindow?.postMessage(message, "*");
    };
    const init = (): void => {
      send({
        type: "kestrel:init",
        mode: "mount",
        extensionId: extension.id,
        slot: extension.slot,
        plugin: extension.plugin,
        endpoint: extension.endpoint,
        entry: extension.entry,
        css: extension.css,
        sessionId,
        theme: themeVariables(),
      });
    };

    let scheduled = false;
    const sendTheme = (): void => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        send({ type: "kestrel:theme", vars: themeVariables() });
      });
    };

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== element.contentWindow) return;
      const data = event.data as
        | {
            type?: string;
            height?: unknown;
            message?: unknown;
            id?: unknown;
            path?: unknown;
            init?: unknown;
            ok?: unknown;
            data?: unknown;
            error?: unknown;
          }
        | undefined;
      if (!data || typeof data !== "object") return;

      if (data.type === "kestrel:ready") {
        init();
      } else if (data.type === "kestrel:mounted") {
        mounted = true;
      } else if (data.type === "kestrel:height") {
        if (typeof data.height === "number" && Number.isFinite(data.height)) {
          setHeight(Math.max(0, Math.ceil(data.height)));
        }
      } else if (data.type === "kestrel:error") {
        setError(typeof data.message === "string" ? data.message : "The extension failed.");
      } else if (data.type === "kestrel:request" && typeof data.id === "number") {
        if (typeof data.path !== "string") return;
        const init = (data.init ?? {}) as RequestInit;
        api
          .request(data.path, init)
          .then((result) => send({ type: "kestrel:response", id: data.id, ok: true, data: result }))
          .catch((cause: unknown) =>
            send({
              type: "kestrel:response",
              id: data.id,
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          );
      }
    };

    window.addEventListener("message", onMessage);
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    scheme.addEventListener("change", sendTheme);
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    // Set src after the listener: a cached iframe can post `ready` immediately.
    element.src = `${api.endpoint}/plugin-sandbox.html`;

    return () => {
      window.removeEventListener("message", onMessage);
      scheme.removeEventListener("change", sendTheme);
      observer.disconnect();
      if (mounted) element.src = "about:blank";
    };
  }, [api, extension, sessionId]);

  if (error) {
    return (
      <div className="plugin-extension-error" role="status">
        Extension {extension.id} failed: {error}
      </div>
    );
  }

  return (
    <iframe
      ref={frame}
      className="plugin-frame"
      data-slot={extension.slot}
      data-plugin={extension.plugin.id}
      title={`${extension.plugin.name}: ${extension.id}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height: `${height}px` }}
    />
  );
}
