/**
 * Server side of the example. It registers a tiny service other plugins can
 * consume; the browser bundle in `web/` is loaded separately by the console.
 */
export default {
  name: "@example/plugin-web-metrics",
  version: "0.1.0",
  description: "Example plugin with a browser contribution.",
  apply(context) {
    const startedAt = Date.now();
    context.provide("web-metrics", {
      startedAt,
      uptimeMs: () => Date.now() - startedAt,
    });
    context.logger.info("web metrics service registered");
  },
};
