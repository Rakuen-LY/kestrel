/**
 * Browser contribution for the web-metrics example.
 *
 * The console imports this module from `/plugins/<id>/panel.js` after the
 * plugin reports `state: "active"`, calls the default export once, and mounts
 * every registered extension into its slot. `api.context.request` is an
 * authenticated JSON call; the token itself is never handed to plugin code.
 */
export default function activate(api) {
  const { plugin, request } = api.context;

  api.register({
    id: "sidebar-summary",
    slot: "sidebar.footer",
    order: 10,
    mount(element) {
      let disposed = false;
      const render = async () => {
        try {
          const [{ sessions }, { plugins }] = await Promise.all([
            request("/api/sessions"),
            request("/api/plugins"),
          ]);
          if (disposed) return;
          const running = sessions.filter((session) => session.status === "running").length;
          element.textContent = `${sessions.length} sessions · ${running} running · ${plugins.length} plugins`;
        } catch {
          if (!disposed) element.textContent = "metrics unavailable";
        }
      };
      void render();
      const timer = setInterval(render, 15000);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    },
  });

  api.register({
    id: "settings-about",
    slot: "settings.section",
    order: 90,
    mount(element) {
      const heading = document.createElement("h3");
      heading.textContent = "Web metrics";
      const note = document.createElement("p");
      note.className = "settings-note";
      note.textContent = `Browser bundle ${plugin.name} v${plugin.version}. Everything above is rendered by the plugin, not the console.`;
      element.append(heading, note);
    },
  });
}
