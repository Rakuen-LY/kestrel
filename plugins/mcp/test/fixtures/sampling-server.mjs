import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

let capabilities = {};
let nextSamplingId = 1;
const pending = new Map();

const tools = [
  {
    name: "caps",
    description: "Report the capabilities the client declared.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask",
    description: "Ask the client's model a question through sampling.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "ask_twice",
    description: "Ask two questions; used to exercise the request budget.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "initialize") {
    capabilities = message.params?.capabilities ?? {};
    result(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { sampling: {} },
      serverInfo: { name: "sampling-fixture", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    result(message.id, { tools });
    return;
  }
  if (message.method === "resources/list") {
    result(message.id, { resources: [] });
    return;
  }
  if (message.method === "prompts/list") {
    result(message.id, { prompts: [] });
    return;
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "caps") {
      result(message.id, { content: [{ type: "text", text: JSON.stringify(capabilities) }] });
      return;
    }
    if (name === "ask" || name === "ask_twice") {
      const question = String(message.params?.arguments?.question ?? "");
      const samplingId = nextSamplingId++;
      pending.set(samplingId, { toolId: message.id, question, remaining: name === "ask_twice" ? 1 : 0 });
      send({
        jsonrpc: "2.0",
        id: samplingId,
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: question } }],
          systemPrompt: "Answer in one short sentence.",
          maxTokens: 64,
        },
      });
      return;
    }
    failure(message.id, -32602, `unknown tool ${String(name)}`);
    return;
  }

  if (pending.has(message.id)) {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      result(call.toolId, {
        content: [{ type: "text", text: `sampling error: ${message.error.message}` }],
        isError: true,
      });
      return;
    }
    const text = message.result?.content?.text ?? "";
    if (call.remaining > 0) {
      const samplingId = nextSamplingId++;
      pending.set(samplingId, { ...call, remaining: call.remaining - 1, previous: text });
      send({
        jsonrpc: "2.0",
        id: samplingId,
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: `${call.question} (again)` } }],
          maxTokens: 64,
        },
      });
      return;
    }
    result(call.toolId, {
      content: [{ type: "text", text: `sampled: ${call.previous ? `${call.previous} / ` : ""}${text}` }],
    });
  }
});
