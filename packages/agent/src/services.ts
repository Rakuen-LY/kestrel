import type { SessionEvent } from "@kestrel/protocol";
import type { ModelRegistry, ToolRegistry } from "./registry.js";
import type { SessionManager } from "./manager.js";
import type { PromptPipeline } from "./prompts.js";

/**
 * Type-level integration with the kernel. Importing `@kestrel/agent` makes
 * these services discoverable from any plugin context without casts.
 */
declare module "@kestrel/kernel" {
  interface ServiceMap {
    models: ModelRegistry;
    tools: ToolRegistry;
    sessions: SessionManager;
    prompts: PromptPipeline;
  }

  interface EventMap {
    "session/event": (event: SessionEvent) => void;
  }
}

