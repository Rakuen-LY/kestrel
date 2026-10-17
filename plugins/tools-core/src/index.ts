import type { Context } from "@kestrel/kernel";
import { createCoreTools, type CoreToolsConfig } from "./tools.js";

export type { CoreToolsConfig };
export { createCoreTools, htmlToText } from "./tools.js";

export default {
  name: "@kestrel/plugin-tools-core",
  version: "0.1.0",
  description: "Filesystem, process, network and planning tools for the Kestrel agent.",
  inject: ["tools"],
  apply(context: Context, config: CoreToolsConfig = {}) {
    const registry = context.get("tools");
    const tools = createCoreTools(config);
    for (const tool of tools) {
      context.effect(() => registry.register(tool));
    }
    context.logger.info("core tools registered", { count: tools.length });
  },
};
