/**
 * The product version reported by the HTTP API, the server CLI and the agent
 * CLI. `pnpm version:set` rewrites this constant together with every workspace
 * `package.json`, and the version test fails if they ever disagree.
 */
export const KESTREL_VERSION = "0.2.0";
