import type { Disposer } from "@kestrel/kernel";

export interface PromptContext {
  workspace: string;
  sessionId?: string;
  tools: readonly string[];
  /** Delegation depth; `0` or absent for a session a human started. */
  depth?: number;
  /** Subagent role name, when this session was delegated. */
  role?: string;
}

/**
 * A prompt layer receives the prompt produced by earlier layers and returns a
 * new one. Layers are synchronous by design: they run when a session is
 * created, so a slow layer would delay `POST /api/sessions`.
 */
export interface PromptLayer {
  name: string;
  /** Lower numbers run first; ties keep registration order. */
  order?: number;
  transform(prompt: string, context: PromptContext): string;
}

export interface PromptPipelineOptions {
  onError?: (layer: PromptLayer, error: unknown) => void;
}

/**
 * The extension point behind "everything is a plugin": identity, workspace
 * context, skills and policies are layers over one base prompt rather than
 * conditional branches in the agent loop.
 */
export class PromptPipeline {
  private readonly layers: PromptLayer[] = [];

  constructor(private readonly options: PromptPipelineOptions = {}) {}

  add(layer: PromptLayer): Disposer {
    const index = this.layers.push(layer) - 1;
    return () => {
      const current = this.layers[index];
      if (current === layer) this.layers.splice(index, 1);
    };
  }

  render(base: string, context: PromptContext): string {
    const ordered = [...this.layers].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    let prompt = base;
    for (const layer of ordered) {
      try {
        prompt = layer.transform(prompt, context);
      } catch (error) {
        // A broken context source must not take session creation down with it.
        this.options.onError?.(layer, error);
      }
    }
    return prompt;
  }

  list(): string[] {
    return [...this.layers].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)).map((layer) => layer.name);
  }
}
