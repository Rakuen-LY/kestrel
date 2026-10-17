import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@kestrel/kernel", replacement: r("./packages/kernel/src/index.ts") },
      { find: "@kestrel/protocol", replacement: r("./packages/protocol/src/index.ts") },
      { find: "@kestrel/agent", replacement: r("./packages/agent/src/index.ts") },
      { find: "@kestrel/plugin-host", replacement: r("./packages/plugin-host/src/index.ts") },
      { find: /^@kestrel\/plugin-(.+)$/, replacement: `${r("./plugins")}/$1/src/index.ts` },
      { find: "@kestrel/testkit", replacement: r("./packages/testkit/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "plugins/**/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
  },
});
