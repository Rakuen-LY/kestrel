import type {
  CompletionRequest,
  CompletionResponse,
  LanguageModel,
  ModelInfo,
  TokenDelta,
  Tool,
  ToolExecutionResult,
} from "@kestrel/agent";
import type { ModelRegistry, ToolRegistry } from "@kestrel/agent";

export interface ScriptedTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>;
  usage?: Partial<CompletionResponse["usage"]>;
}

/** A deterministic model for tests and local demos. */
export class ScriptedModel implements LanguageModel {
  readonly info: ModelInfo;
  readonly requests: CompletionRequest[] = [];
  private readonly turns: ScriptedTurn[];
  private index = 0;

  constructor(turns: ScriptedTurn[], info: Partial<ModelInfo> = {}) {
    this.turns = [...turns];
    this.info = { id: info.id ?? "scripted", provider: info.provider ?? "testkit", supportsTools: true, ...info };
  }

  async generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)] ?? {};
    this.index += 1;
    const content = turn.content ?? "";
    if (onDelta) {
      for (const chunk of chunkText(content)) onDelta({ channel: "text", delta: chunk });
      if (turn.reasoning) onDelta({ channel: "reasoning", delta: turn.reasoning });
    }
    const toolCalls = (turn.toolCalls ?? []).map((call, position) => ({
      id: call.id ?? `call_${this.index}_${position}`,
      name: call.name,
      arguments: call.arguments,
    }));
    const inputTokens = turn.usage?.inputTokens ?? 10;
    const outputTokens = turn.usage?.outputTokens ?? 5;
    return {
      content,
      reasoning: turn.reasoning,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: turn.usage?.totalTokens ?? inputTokens + outputTokens,
      },
      finishReason: toolCalls.length ? "tool_calls" : "stop",
    };
  }
}

function chunkText(text: string, size = 8): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

export interface EchoToolOptions {
  name?: string;
  permission?: "auto" | "ask";
  result?: (args: Record<string, unknown>) => ToolExecutionResult;
}

export function echoTool(options: EchoToolOptions = {}): Tool {
  return {
    schema: {
      name: options.name ?? "echo",
      description: "Echo the provided text.",
      permission: options.permission ?? "auto",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo." } },
        required: ["text"],
      },
    },
    execute(args) {
      if (options.result) return options.result(args);
      return { content: String(args.text ?? "") };
    },
  };
}

export function registerTestModel(
  models: ModelRegistry,
  turns: ScriptedTurn[],
  info: Partial<ModelInfo> = {},
): ScriptedModel {
  const model = new ScriptedModel(turns, info);
  models.register(model, { setDefault: true });
  return model;
}

export function registerEchoTool(tools: ToolRegistry): () => void {
  return tools.register(echoTool());
}
