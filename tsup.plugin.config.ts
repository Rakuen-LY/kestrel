import { defineConfig } from "tsup";

/**
 * Plugins ship alone: the container image copies `plugins/**` without the
 * workspace packages or the root `node_modules`, so anything imported from
 * `@kestrel/*` has to be inlined here.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: [/^@kestrel\//],
  // tsup strips `node:` by default, which would turn a builtin into a package
  // lookup inside the standalone bundle.
  removeNodeProtocol: false,
});
