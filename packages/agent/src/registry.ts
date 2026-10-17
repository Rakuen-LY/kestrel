import type { JsonSchema, ModelInfo, ToolSchema } from "@kestrel/protocol";
import type { JsonValidationIssue, LanguageModel, ModelRegistryOptions, Tool, ToolRegistration } from "./types.js";

/**
 * Holds every model the platform can talk to. Providers register concrete
 * `LanguageModel` instances, which lets a plugin expose one model, an entire
 * hosted catalogue, or a local runtime behind the same interface.
 */
export class ModelRegistry {
  private readonly models = new Map<string, LanguageModel>();
  private defaultId?: string;
  private explicitDefault = false;

  constructor(options: ModelRegistryOptions = {}) {
    this.defaultId = options.defaultModel;
  }

  /**
   * `setDefault` claims the default only when none is configured yet, so a
   * provider installed later cannot silently hijack an explicit choice.
   */
  register(model: LanguageModel, options: { setDefault?: boolean } = {}): () => void {
    const id = model.info.id;
    this.models.set(id, model);
    if (!this.defaultId || (options.setDefault && !this.explicitDefault)) this.defaultId = id;
    return () => {
      if (this.models.get(id) === model) this.models.delete(id);
      if (this.defaultId === id) {
        this.explicitDefault = false;
        this.defaultId = this.models.keys().next().value;
      }
    };
  }

  get(id?: string): LanguageModel {
    const resolved = id ?? this.defaultId;
    if (!resolved) throw new Error("No language model is configured. Install a provider plugin or set `model.default`.");
    const model = this.models.get(resolved);
    if (!model) {
      throw new Error(`Unknown model "${resolved}". Available: ${[...this.models.keys()].join(", ") || "(none)"}`);
    }
    return model;
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  setDefault(id: string): void {
    if (!this.models.has(id)) throw new Error(`Cannot set unknown model "${id}" as default.`);
    this.defaultId = id;
    this.explicitDefault = true;
  }

  get defaultModel(): string | undefined {
    return this.defaultId;
  }

  list(): ModelInfo[] {
    return [...this.models.values()].map((model) => model.info).sort((a, b) => a.id.localeCompare(b.id));
  }

  dispose(): void {
    this.models.clear();
  }
}

export class ToolRegistry implements ToolRegistration {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): () => void {
    const name = tool.schema.name;
    if (!name) throw new Error("Tool schema requires a name.");
    if (this.tools.has(name)) throw new Error(`Tool "${name}" is already registered.`);
    this.tools.set(name, tool);
    return () => {
      if (this.tools.get(name) === tool) this.tools.delete(name);
    };
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()].sort((a, b) => a.schema.name.localeCompare(b.schema.name));
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => tool.schema);
  }

  get size(): number {
    return this.tools.size;
  }
}

export function formatValidationIssues(issues: JsonValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || "$"}: ${issue.message}`).join("; ");
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Small, dependency-free JSON Schema subset. It deliberately validates only
 * the constraints that tool authors rely on (types, required keys, enums and
 * array items) and leaves advanced keywords to the tool itself.
 */
export function validateArguments(schema: JsonSchema, value: unknown, path = ""): JsonValidationIssue[] {
  const issues: JsonValidationIssue[] = [];

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ path, message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}` });
    return issues;
  }

  switch (schema.type) {
    case "object": {
      if (describeType(value) !== "object") {
        issues.push({ path, message: `must be an object, received ${describeType(value)}` });
        break;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) issues.push({ path: path ? `${path}.${key}` : key, message: "is required" });
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (key in record) issues.push(...validateArguments(child, record[key], path ? `${path}.${key}` : key));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in (schema.properties ?? {}))) {
            issues.push({ path: path ? `${path}.${key}` : key, message: "is not an allowed property" });
          }
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `must be an array, received ${describeType(value)}` });
        break;
      }
      if (schema.items) {
        value.forEach((item, index) => {
          issues.push(...validateArguments(schema.items as JsonSchema, item, `${path}[${index}]`));
        });
      }
      break;
    }
    case "string":
      if (typeof value !== "string") issues.push({ path, message: `must be a string, received ${describeType(value)}` });
      break;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        issues.push({ path, message: `must be a number, received ${describeType(value)}` });
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        issues.push({ path, message: `must be an integer, received ${describeType(value)}` });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") issues.push({ path, message: `must be a boolean, received ${describeType(value)}` });
      break;
    case "null":
      if (value !== null) issues.push({ path, message: `must be null, received ${describeType(value)}` });
      break;
    default:
      break;
  }

  return issues;
}
