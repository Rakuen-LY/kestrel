/** Configuration and role defaults for `@kestrel/plugin-subagents`. */
export interface SubagentRole {
  /** Shown to the parent model and in the delegation prompt. */
  description: string;
  /** Standing brief appended to the subagent's framing. */
  instructions?: string;
  model?: string;
  maxSteps?: number;
  /** Tool allowlist. Omit for "every tool that cannot prompt a human". */
  allowTools?: string[];
}

export interface SubagentsConfig {
  /** Maximum delegation depth. `2` allows subagents and their subagents. */
  maxDepth?: number;
  /** Concurrent subagents per parent session. `0` means unbounded. */
  maxConcurrent?: number;
  /** Tasks a single `delegate_many` call may start. */
  maxFanOut?: number;
  /** Total characters of subagent reports returned by one `delegate_many`. */
  maxBatchResultChars?: number;
  /** Default step budget for a delegated run. */
  maxSteps?: number;
  /** Wall-clock limit for one delegated run. */
  timeoutMs?: number;
  /** Characters of the subagent's final answer returned to the parent. */
  maxResultChars?: number;
  /**
   * Include tools whose permission is `ask`. Off by default: a subagent's
   * approval prompt belongs to a session the human is not watching, so the
   * request would block until the run times out.
   */
  exposeApprovalTools?: boolean;
  roles?: Record<string, SubagentRole>;
}

export type ResolvedRole = SubagentRole & { name: string };

export const SUBAGENT_DEFAULTS = {
  maxDepth: 2,
  maxConcurrent: 3,
  maxFanOut: 6,
  maxSteps: 12,
  timeoutMs: 10 * 60_000,
  maxResultChars: 20_000,
  maxBatchResultChars: 40_000,
  /** Floor per task, so a large batch cannot truncate every report to nothing. */
  minBatchResultChars: 1_500,
  exposeApprovalTools: false,
} as const;

/**
 * Roles are prompts with a budget. They exist so the parent can delegate
 * without inventing an instruction every time, and so operators can bound what
 * a delegated run is allowed to touch.
 */
export const DEFAULT_ROLES: Record<string, SubagentRole> = {
  general: {
    description: "Any scoped task that benefits from a fresh, isolated context.",
    instructions: "Use the narrowest set of tools that answers the task.",
  },
  researcher: {
    description: "Read-only investigation: find code, trace behaviour, summarise a design.",
    instructions:
      "Stay read-only. Cite files by path and line when you report findings. Prefer several targeted searches over reading whole trees.",
    allowTools: [
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "fetch",
      "use_skill",
      "memory_search",
      "memory_list",
      "todo_write",
    ],
  },
  reviewer: {
    description: "Review a change or a file for correctness, risk and missing tests.",
    instructions:
      "Report concrete findings with file and line references, ordered by severity. Do not edit files. Say plainly when you find nothing.",
    allowTools: ["read_file", "list_dir", "glob", "grep", "use_skill", "memory_search", "memory_list"],
  },
  implementer: {
    description: "Make a bounded code change in the workspace and report exactly what changed.",
    instructions:
      "Make the smallest change that fully solves the task. Do not refactor beyond scope. If you cannot verify the change, say what prevented you.",
    allowTools: [
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "glob",
      "grep",
      "fetch",
      "use_skill",
      "memory_search",
      "memory_list",
      "memory_save",
      "todo_write",
    ],
  },
};

/**
 * User configuration extends a built-in role instead of replacing it, so adding
 * a `model` to `researcher` does not silently drop its read-only allowlist.
 */
export function roleTable(config: SubagentsConfig = {}): Record<string, SubagentRole> {
  const table: Record<string, SubagentRole> = { ...DEFAULT_ROLES };
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    table[name] = { ...table[name], ...role };
  }
  return table;
}

export function resolveRole(config: SubagentsConfig, name: string): ResolvedRole | undefined {
  const role = roleTable(config)[name];
  return role ? { ...role, name } : undefined;
}
