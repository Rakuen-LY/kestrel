export interface SandboxExecOptions {
  command: string;
  /** Directory the command runs in; must be inside `workspace`. */
  cwd: string;
  /** Session workspace, mounted into the sandbox by implementations that need it. */
  workspace: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra environment variables. Implementations may add their own. */
  env?: Record<string, string>;
}

export interface SandboxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs commands somewhere other than the server process. Tools treat this as
 * best-effort isolation, not as a security boundary: a sandbox decides what
 * the command can see, and no sandbox may silently fall back to the host.
 */
export interface Sandbox {
  readonly name: string;
  exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
}

export type SandboxResolver = () => Sandbox | undefined;

declare module "@kestrel/kernel" {
  interface ServiceMap {
    sandbox: Sandbox;
  }
}
