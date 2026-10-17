import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/bin.ts"],
  format: ["esm"],
  target: "node22",
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/^@kestrel\//],
});
