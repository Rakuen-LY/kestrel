import { useEffect, useRef } from "react";
import type { KestrelApi } from "../api.js";
import type { ConsoleContext, LoadedExtension, SlotName } from "../extensions.js";

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
        <PluginMount
          key={`${extension.plugin.id}:${extension.id}`}
          extension={extension}
          context={{
            plugin: extension.plugin,
            endpoint: api.endpoint,
            sessionId,
            request: (path, init) => api.request(path, init),
          }}
        />
      ))}
    </>
  );
}

function PluginMount({ extension, context }: { extension: LoadedExtension; context: ConsoleContext }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cleanup: void | (() => void);
    try {
      cleanup = extension.mount(element, context);
    } catch (error) {
      element.textContent = `Extension "${extension.id}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      element.dataset.failed = "true";
    }
    return () => {
      if (typeof cleanup === "function") cleanup();
      element.replaceChildren();
    };
    // The context is rebuilt on session changes; mount keys off the session id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extension, context.sessionId]);

  return <div className="plugin-extension" data-plugin={extension.plugin.id} data-slot={extension.slot} ref={host} />;
}
