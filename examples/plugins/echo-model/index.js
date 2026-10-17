/**
 * A minimal plugin written in plain ESM: no build step, no dependencies.
 * It registers a model whose answers are deterministic so the platform can be
 * demoed and tested without network access or API keys.
 */
export default {
  name: "@example/plugin-echo-model",
  version: "0.1.0",
  description: "Deterministic offline model.",
  inject: ["models"],
  apply(context, config) {
    const id = config.id ?? "echo";
    const model = {
      info: {
        id,
        provider: "example",
        label: "Echo (offline)",
        supportsTools: false,
        supportsReasoning: false,
      },
      async generate(request, onDelta) {
        const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
        const prompt = lastUser?.content ?? "";
        const text = [
          `## Echo`,
          "",
          `You said: **${prompt.slice(0, 400)}**`,
          "",
          `- model: \`${id}\``,
          `- tools available: ${request.tools.length}`,
          `- messages in context: ${request.messages.length}`,
          "",
          "This model is provided by an example plugin; install a real provider to talk to an LLM.",
        ].join("\n");
        for (let index = 0; index < text.length; index += 24) {
          onDelta?.({ channel: "text", delta: text.slice(index, index + 24) });
        }
        const usage = { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) };
        return {
          content: text,
          toolCalls: [],
          usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
          finishReason: "stop",
        };
      },
    };
    context.effect(() => context.get("models").register(model));
    context.logger.info("echo model registered", { id });
  },
};
