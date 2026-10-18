import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/errors.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // tsup strips `node:` by default, which turns `node:sqlite` into a package lookup.
  removeNodeProtocol: false,
});
