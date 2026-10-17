import { parseArgs } from "node:util";
import { createHttpServer } from "./http.js";
import { createRuntime } from "./runtime.js";

const HELP = `Kestrel server

Usage: kestrel-server [options]

Options:
  -c, --config <path>     Configuration file (default: kestrel.config.json)
      --host <host>       Bind address (default: 127.0.0.1)
  -p, --port <port>       Bind port (default: 7331)
      --token <token>     Bearer token; empty disables authentication
      --workspace <path>  Agent workspace root
  -h, --help              Show this help
  -v, --version           Print the version
`;

export async function start(overrides: { config?: string; host?: string; port?: string; token?: string; workspace?: string } = {}) {
  if (overrides.host) process.env.KESTREL_HOST = overrides.host;
  if (overrides.port) process.env.KESTREL_PORT = overrides.port;
  if (overrides.token !== undefined) process.env.KESTREL_TOKEN = overrides.token;
  if (overrides.workspace) process.env.KESTREL_WORKSPACE = overrides.workspace;

  const runtime = await createRuntime({ configPath: overrides.config });
  const server = createHttpServer(runtime);
  const { host, port } = runtime.config.server;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  runtime.logger.info(`Kestrel listening on ${address}`, {
    workspace: runtime.config.agent.workspace ?? ".",
    authentication: Boolean(runtime.config.server.token),
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    runtime.logger.info("shutting down", { signal });
    server.close();
    await runtime.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return { server, runtime, address };
}

export async function main(): Promise<void> {
  let values;
  try {
    values = parseArgs({
      options: {
        config: { type: "string", short: "c" },
        host: { type: "string" },
        port: { type: "string", short: "p" },
        token: { type: "string" },
        workspace: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write("kestrel-server 0.1.0\n");
    return;
  }

  try {
    await start({
      config: values.config as string | undefined,
      host: values.host as string | undefined,
      port: values.port as string | undefined,
      token: values.token as string | undefined,
      workspace: values.workspace as string | undefined,
    });
  } catch (error) {
    process.stderr.write(`Failed to start Kestrel: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
}
