/**
 * Contributes one tool to the shared tool registry. Note that it never imports
 * the tools-core plugin: both cooperate through the `tools` service.
 */
export default {
  name: "@example/plugin-clock-tool",
  version: "0.1.0",
  description: "Adds a clock tool.",
  inject: ["tools"],
  apply(context) {
    const tool = {
      schema: {
        name: "clock_now",
        description: "Return the current date and time, optionally in a specific IANA time zone.",
        category: "example",
        permission: "auto",
        parameters: {
          type: "object",
          properties: {
            timeZone: { type: "string", description: "IANA time zone such as Europe/Berlin." },
          },
          additionalProperties: false,
        },
      },
      execute(args) {
        const timeZone = typeof args.timeZone === "string" ? args.timeZone : undefined;
        try {
          const now = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "long" });
          return { content: now, data: { iso: new Date().toISOString(), timeZone: timeZone ?? "local" } };
        } catch {
          return { content: `Unknown time zone: ${timeZone}`, isError: true };
        }
      },
    };
    context.effect(() => context.get("tools").register(tool));
    context.logger.info("clock tool registered");
  },
};
