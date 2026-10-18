import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { start } from "@kestrel/server";
import {
  AuthStore,
  createRuntime,
  loadConfig,
  resolveDataDirectory,
  resolveMode,
  resolveWorkspace,
  type Runtime,
  type UserRecord,
} from "@kestrel/server";
import { isSessionGuardError } from "@kestrel/agent";
import { SkillCatalog } from "@kestrel/plugin-skills";
import type { ServerEventEnvelope } from "@kestrel/protocol";

const HELP = `Kestrel — plugin-first agent platform

Usage:
  kestrel serve [--host H] [--port P] [--token T]
  kestrel run <prompt...> [--model M] [--workspace DIR]
  kestrel chat [--model M] [--workspace DIR]
  kestrel plugins
  kestrel models
  kestrel sessions [resume <id>]
  kestrel skills [show <name>]
  kestrel checkpoints [list <session>] [create <session> [--label L]]
                      [restore <session> <checkpoint>]
  kestrel tenants [create <name>]
  kestrel users [create <name> [--role admin|member] [--tenant T] [--email E]]
                [rotate <id|name>] [delete <id|name>]

Global options:
  -c, --config <path>    Configuration file
      --workspace <dir>  Agent workspace root
      --model <id>       Model id for new sessions
      --json             Emit raw JSON events (run only)
  -h, --help             Show help
  -v, --version          Print the version
`;

const color = {
  dim: (text: string) => (stdout.isTTY ? `\x1b[90m${text}\x1b[0m` : text),
  bold: (text: string) => (stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text),
  green: (text: string) => (stdout.isTTY ? `\x1b[32m${text}\x1b[0m` : text),
  yellow: (text: string) => (stdout.isTTY ? `\x1b[33m${text}\x1b[0m` : text),
  red: (text: string) => (stdout.isTTY ? `\x1b[31m${text}\x1b[0m` : text),
  cyan: (text: string) => (stdout.isTTY ? `\x1b[36m${text}\x1b[0m` : text),
};

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      workspace: { type: "string" },
      model: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      role: { type: "string" },
      tenant: { type: "string" },
      email: { type: "string" },
      label: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  if (values.version) {
    stdout.write("kestrel 0.1.0\n");
    return;
  }
  if (values.help || positionals.length === 0) {
    stdout.write(HELP);
    return;
  }

  const command = positionals[0];
  if (values.workspace) process.env.KESTREL_WORKSPACE = values.workspace as string;
  if (values.model) process.env.KESTREL_MODEL = values.model as string;
  // Keep the interactive transcript free of startup noise; `serve` stays verbose.
  if (command === "run" || command === "chat") process.env.KESTREL_LOG_LEVEL ??= "warn";

  if (command === "serve") {
    await start({
      config: values.config as string | undefined,
      host: values.host as string | undefined,
      port: values.port as string | undefined,
      token: values.token as string | undefined,
      workspace: values.workspace as string | undefined,
    });
    return;
  }

  if (command === "plugins") {
    const runtime = await createRuntime({ configPath: values.config as string | undefined });
    try {
      for (const plugin of runtime.plugins.list()) {
        const state = plugin.state === "active" ? color.green("active") : plugin.state === "error" ? color.red("error") : color.yellow(plugin.state);
        stdout.write(`${color.bold(plugin.name)} ${color.dim(plugin.version)}  ${state}\n`);
        if (plugin.description) stdout.write(`  ${color.dim(plugin.description)}\n`);
        if (plugin.error) stdout.write(`  ${color.red(plugin.error)}\n`);
      }
    } finally {
      await runtime.shutdown();
    }
    return;
  }

  if (command === "checkpoints") {
    const runtime = await createRuntime({ configPath: values.config as string | undefined });
    try {
      const subcommand = positionals[1] ?? "list";
      const sessionId = positionals[2];
      const { enabled, reason } = await runtime.checkpoints.status();
      if (!enabled) {
        stdout.write(color.yellow(`${reason ?? "Checkpoints are unavailable."}\n`));
        return;
      }
      if (!sessionId) {
        stdout.write(color.red("Usage: kestrel checkpoints list|create|restore <session-id> [checkpoint-id]\n"));
        process.exitCode = 2;
        return;
      }
      const session = runtime.sessions.get(sessionId);
      if (subcommand === "list") {
        const checkpoints = await runtime.checkpoints.list(session.workspace);
        if (checkpoints.length === 0) {
          stdout.write(color.dim("No checkpoints yet.\n"));
          return;
        }
        for (const checkpoint of checkpoints) {
          const change = `+${checkpoint.changes.added} ~${checkpoint.changes.modified} -${checkpoint.changes.deleted}`;
          stdout.write(
            `${color.bold(checkpoint.id)}  ${checkpoint.createdAt}  ${color.dim(change)}  ${checkpoint.label}\n`,
          );
        }
        return;
      }
      if (subcommand === "create") {
        const checkpoint = await runtime.checkpoints.snapshot(session.workspace, {
          sessionId: session.id,
          label: values.label as string | undefined,
        });
        stdout.write(`${color.green("Created")} ${checkpoint.id}  ${checkpoint.files} files\n`);
        return;
      }
      if (subcommand === "restore") {
        const checkpointId = positionals[3];
        if (!checkpointId) {
          stdout.write(color.red("Usage: kestrel checkpoints restore <session-id> <checkpoint-id>\n"));
          process.exitCode = 2;
          return;
        }
        const result = await runtime.checkpoints.restore(session.workspace, checkpointId);
        stdout.write(
          `${color.green("Restored")} ${result.restored.label}\n${color.dim(`Safety checkpoint: ${result.safety.id}\n`)}`,
        );
        return;
      }
      stdout.write(color.red(`Unknown checkpoints subcommand "${subcommand}".\n`));
      process.exitCode = 2;
    } finally {
      await runtime.shutdown();
    }
    return;
  }

  if (command === "models") {
    const runtime = await createRuntime({ configPath: values.config as string | undefined });
    try {
      for (const model of runtime.models.list()) {
        stdout.write(`${color.bold(model.id)}  ${color.dim(model.provider)}${model.id === runtime.models.defaultModel ? color.green("  (default)") : ""}\n`);
      }
    } finally {
      await runtime.shutdown();
    }
    return;
  }

  if (command === "skills") {
    const config = await loadConfig(values.config as string | undefined);
    const workspace = resolveWorkspace(config);
    const skillsConfig = (config.plugins.config?.["@kestrel/plugin-skills"] ?? {}) as {
      directories?: string[];
      maxSkillBytes?: number;
      maxSkills?: number;
    };
    const catalog = new SkillCatalog(skillsConfig);
    const subcommand = positionals[1];
    if (subcommand === "show") {
      const name = positionals[2];
      if (!name) {
        stdout.write(color.red("Usage: kestrel skills show <name>\n"));
        process.exitCode = 2;
        return;
      }
      const skill = catalog.load(workspace, name);
      if (!skill) {
        stdout.write(color.red(`Unknown skill "${name}". Run \`kestrel skills\` to list them.\n`));
        process.exitCode = 1;
        return;
      }
      if (values.json) {
        stdout.write(`${JSON.stringify(skill, null, 2)}\n`);
      } else {
        stdout.write(`${color.bold(skill.name)}  ${color.dim(`${skill.bytes} bytes · ${skill.path}`)}\n\n${skill.body}\n`);
        if (skill.truncated) stdout.write(color.yellow(`\n(truncated by the maxSkillBytes policy)\n`));
      }
      return;
    }

    const skills = catalog.list(workspace);
    if (values.json) {
      stdout.write(`${JSON.stringify({ workspace, skills }, null, 2)}\n`);
      return;
    }
    if (skills.length === 0) {
      stdout.write(color.dim(`No skills found under ${workspace}. Create skills/<name>/SKILL.md.\n`));
      return;
    }
    for (const skill of skills) {
      stdout.write(`${color.bold(skill.name)}  ${color.dim(`${skill.bytes} bytes`)}${skill.whenToUse ? color.dim(`  when: ${skill.whenToUse}`) : ""}\n`);
      stdout.write(`  ${skill.description}\n`);
    }
    return;
  }

  if (command === "tenants" || command === "users") {
    const config = await loadConfig(values.config as string | undefined);
    const store = new AuthStore(resolveDataDirectory(config));
    await store.load();
    const subcommand = positionals[1];
    const mode = resolveMode(config);

    if (command === "tenants") {
      if (subcommand === "create") {
        const name = positionals.slice(2).join(" ").trim();
        if (!name) {
          stdout.write(color.red("Provide a name: kestrel tenants create <name>\n"));
          process.exitCode = 2;
          return;
        }
        const tenant = await store.createTenant(name);
        stdout.write(`${color.green("created tenant")} ${color.bold(tenant.id)}  ${tenant.name}\n`);
        return;
      }
      const counts = new Map<string, number>();
      for (const user of store.listUsers()) {
        counts.set(user.tenantId, (counts.get(user.tenantId) ?? 0) + 1);
      }
      for (const tenant of store.listTenants()) {
        stdout.write(
          `${color.bold(tenant.id)}  ${tenant.name}  ${color.dim(`${counts.get(tenant.id) ?? 0} user(s)`)}${tenant.id === "default" ? color.dim("  (default)") : ""}\n`,
        );
      }
      return;
    }

    if (subcommand === "create") {
      const name = positionals.slice(2).join(" ").trim();
      if (!name) {
        stdout.write(color.red("Provide a name: kestrel users create <name> [--role admin|member] [--tenant T]\n"));
        process.exitCode = 2;
        return;
      }
      const role = values.role ?? "member";
      if (role !== "admin" && role !== "member") {
        stdout.write(color.red('--role must be "admin" or "member".\n'));
        process.exitCode = 2;
        return;
      }
      const created = await store.createUser({
        name,
        role,
        email: values.email as string | undefined,
        tenantId: values.tenant as string | undefined,
      });
      stdout.write(`${color.green("created user")} ${color.bold(created.user.name)}  ${created.user.role}  tenant: ${created.user.tenantId}\n`);
      stdout.write(`\n${color.bold("Token (shown once):")} ${color.cyan(created.token)}\n`);
      stdout.write(color.dim("Store it now; only a hash is kept. Rotate with `kestrel users rotate <id>`.\n"));
      if (mode !== "accounts") {
        stdout.write(color.yellow('Note: auth.mode is not "accounts"; this token is unused until it is.\n'));
      }
      return;
    }

    if (subcommand === "rotate" || subcommand === "delete") {
      const reference = positionals[2];
      const user = reference ? findUser(store, reference) : undefined;
      if (!user) {
        stdout.write(color.red("Provide an existing user id or name.\n"));
        process.exitCode = 2;
        return;
      }
      if (subcommand === "delete") {
        await store.deleteUser(user.id);
        stdout.write(`${color.green("deleted")} ${user.name}${user.tenantId === "default" ? "" : `  (${user.tenantId})`}\n`);
        return;
      }
      const rotated = await store.rotateToken(user.id);
      stdout.write(`${color.green("rotated")} ${user.name}\n${color.bold("New token (shown once):")} ${color.cyan(rotated?.token ?? "")}\n`);
      return;
    }

    const users = store.listUsers();
    if (users.length === 0) {
      stdout.write(color.dim('No users yet. Create one: kestrel users create <name> --role admin\n'));
      return;
    }
    for (const user of users) {
      stdout.write(
        `${color.bold(user.name)}  ${user.role}  tenant: ${user.tenantId}  ${color.dim(user.id)}  ${color.dim(user.tokenHint)}${user.disabled ? color.yellow("  disabled") : ""}\n`,
      );
    }
    return;
  }

  if (command === "sessions") {
    const runtime = await createRuntime({ configPath: values.config as string | undefined });
    try {
      if (positionals[1] === "resume") {
        const id = positionals[2];
        if (!id) {
          stdout.write("Usage: kestrel sessions resume <id>\n");
          process.exitCode = 2;
          return;
        }
        const session = runtime.sessions.get(id);
        const print = createPrinter(false);
        const unsubscribe = runtime.sessions.subscribe((event) => {
          if (!("sessionId" in event) || event.sessionId !== session.id) return;
          const text = print(event);
          if (text) stdout.write(text);
        });
        try {
          await snapshotBefore(runtime, session, "Resume interrupted run");
          await session.resume().done;
          stdout.write("\n");
        } catch (error) {
          stdout.write(color.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
          process.exitCode = 1;
        } finally {
          unsubscribe();
        }
        return;
      }
      for (const session of runtime.sessions.list()) {
        const indent = "  ".repeat(session.depth ?? 0);
        const marker = session.depth ? `${color.dim("↳ ")}` : "";
        const role = session.role ? color.dim(` [${session.role}]`) : "";
        stdout.write(
          `${indent}${marker}${color.bold(session.id)}  ${session.updatedAt}  ${session.status}  ${session.messageCount} msgs${role}  ${session.title}\n`,
        );
      }
    } finally {
      await runtime.shutdown();
    }
    return;
  }

  if (command === "run" || command === "chat") {
    const runtime = await createRuntime({ configPath: values.config as string | undefined });
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      attachApprovalPrompt(runtime, rl);
      if (command === "run") {
        const prompt = positionals.slice(1).join(" ").trim();
        if (!prompt) {
          stdout.write(color.red("Provide a prompt: kestrel run \"...\"\n"));
          process.exitCode = 2;
          return;
        }
        await runOnce(runtime, prompt, Boolean(values.json));
      } else {
        await chatLoop(runtime, rl);
      }
    } finally {
      rl.close();
      await runtime.shutdown();
    }
    return;
  }

  stdout.write(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 2;
}

function findUser(store: AuthStore, reference: string): UserRecord | undefined {
  const byId = store.user(reference);
  if (byId) return byId;
  const matches = store.listUsers().filter((user) => user.name === reference);
  return matches.length === 1 ? matches[0] : undefined;
}

function attachApprovalPrompt(runtime: Runtime, rl: ReturnType<typeof createInterface>): void {
  runtime.sessions.subscribe((event) => {
    if (event.type !== "approval.requested") return;
    const call = event.approval.call;
    const args = JSON.stringify(call.arguments);
    void (async () => {
      if (!stdin.isTTY) {
        runtime.approvals.decide(event.approval.id, false);
        return;
      }
      const answer = await rl.question(
        `\n${color.yellow("Approve")} ${color.bold(call.name)} ${color.dim(args.slice(0, 300))} ${color.dim("[y/N]")} `,
      );
      runtime.approvals.decide(event.approval.id, /^y(es)?$/i.test(answer.trim()));
    })();
  });
}

/**
 * Models that stream emit `message.delta`; models that only return a whole
 * response (local servers, scripted providers) emit nothing until
 * `message.completed`. Track which messages streamed so the console never
 * prints an answer twice, and never prints nothing at all.
 */
function createPrinter(json: boolean): (event: ServerEventEnvelope["event"]) => string {
  const streamed = new Set<string>();
  return (event) => {
    if (json) return `${JSON.stringify(event)}\n`;
    switch (event.type) {
      case "message.delta":
        streamed.add(event.messageId);
        return event.delta;
      case "message.completed":
        if (event.message.role !== "assistant" || !event.message.content) return "";
        return streamed.has(event.message.id) ? "" : `${event.message.content}\n`;
      case "tool.started":
        return `\n${color.cyan("→")} ${color.bold(event.call.name)} ${color.dim(JSON.stringify(event.call.arguments).slice(0, 300))}\n`;
      case "tool.finished": {
        const head = event.result.content.split("\n").slice(0, 12).join("\n");
        return `${color.dim(head)}${event.result.ok ? "" : color.red("\n(tool failed)")}\n`;
      }
      case "run.failed":
        return `\n${color.red(`Run failed: ${event.error}`)}\n`;
      case "notice":
        return `${color.yellow(event.message)}\n`;
      case "approval.resolved":
        return color.dim(`\nApproval ${event.approved ? "granted" : "denied"}.\n`);
      default:
        return "";
    }
  };
}

/** Best-effort snapshot; a missing git binary must not block a CLI run. */
async function snapshotBefore(runtime: Runtime, session: { id: string; workspace: string }, input: string): Promise<void> {
  const label = input.trim().replace(/\s+/g, " ").slice(0, 72);
  try {
    await runtime.checkpoints.snapshot(session.workspace, {
      sessionId: session.id,
      label: label ? `Before: ${label}` : "Before turn",
    });
  } catch (error) {
    runtime.logger.warn("checkpoint skipped", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function runOnce(runtime: Runtime, prompt: string, json: boolean): Promise<void> {
  const session = runtime.sessions.create({});
  const print = createPrinter(json);
  const unsubscribe = runtime.sessions.subscribe((event) => {
    if (!("sessionId" in event) || event.sessionId !== session.id) return;
    if (event.type === "run.finished") return;
    const text = print(event);
    if (text) stdout.write(text);
  });
  await snapshotBefore(runtime, session, prompt);
  try {
    await session.start(prompt).done;
  } catch {
    // The failure was already rendered from the `run.failed` event.
    process.exitCode = 1;
  } finally {
    unsubscribe();
    stdout.write("\n");
  }
  if (!json) stdout.write(color.dim(`Session: ${session.id}\n`));
}

async function chatLoop(runtime: Runtime, rl: ReturnType<typeof createInterface>): Promise<void> {
  let session = runtime.sessions.create({});
  const print = createPrinter(false);
  runtime.sessions.subscribe((event) => {
    if (!("sessionId" in event) || event.sessionId !== session.id) return;
    const text = print(event);
    if (text) stdout.write(text);
  });

  stdout.write(`${color.bold("Kestrel chat")} ${color.dim("— /new /cancel /help /exit")}\n`);
  while (true) {
    let input: string;
    try {
      input = await rl.question(`${color.green("you ›")} `);
    } catch {
      break;
    }
    const trimmed = input.trim();
    if (!trimmed) continue;
    if (trimmed === "/exit" || trimmed === "/quit") break;
    if (trimmed === "/help") {
      stdout.write(`${color.dim("/new  start a new session\n/cancel  stop the active run\n/exit  leave the chat\n")}`);
      continue;
    }
    if (trimmed === "/new") {
      if (session.isRunning) {
        stdout.write(color.yellow("Cancel the active run first.\n"));
        continue;
      }
      session = runtime.sessions.create({});
      stdout.write(color.dim(`New session ${session.id}\n`));
      continue;
    }
    if (trimmed === "/cancel") {
      stdout.write(color.dim(session.cancel() ? "Cancelling…\n" : "Nothing is running.\n"));
      continue;
    }
    if (session.isRunning) {
      stdout.write(color.yellow("Still running. Use /cancel first.\n"));
      continue;
    }
    stdout.write("\n");
    await snapshotBefore(runtime, session, trimmed);
    try {
      await session.start(trimmed).done;
    } catch (error) {
      stdout.write(color.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    stdout.write("\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isSessionGuardError(error)) {
      stderr.write(`${color.red("Rejected:")} ${message}\n`);
      process.exitCode = 2;
      return;
    }
    stderr.write(`${color.red("Error:")} ${message}\n`);
    if (process.env.KESTREL_DEBUG && error instanceof Error && error.stack) {
      stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
}
