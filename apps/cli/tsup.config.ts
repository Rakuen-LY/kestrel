import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/^@kestrel\//],
  // tsup strips `node:` by default, which turns `node:sqlite` into a package lookup.
  removeNodeProtocol: false,
});
