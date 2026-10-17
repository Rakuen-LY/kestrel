import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Kestrel",
  description: "A plugin-first agent platform. Run autonomous coding agents anywhere, drive them from anywhere.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  markdown: {
    config(md) {
      const fence = md.renderer.rules.fence;
      if (!fence) return;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() === "mermaid") {
          return `<MermaidDiagram code="${encodeURIComponent(token.content)}" />\n`;
        }
        return fence(tokens, index, options, env, self);
      };
    },
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }],
    ["meta", { name: "theme-color", content: "#0b0d12" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Kestrel — plugin-first agent platform" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A kernel, an agent runtime and a plugin host behind one small protocol. Run agents on Linux, macOS, Windows, Docker or Kubernetes; drive them from a browser, desktop shell or phone.",
      },
    ],
  ],
  themeConfig: {
    logo: "/icon.svg",
    siteTitle: "Kestrel",
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "Reference", link: "/reference/config" },
      { text: "Roadmap", link: "/guide/roadmap" },
      { text: "Contributing", link: "/contributing" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Quickstart", link: "/guide/getting-started" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
        {
          text: "Building on Kestrel",
          items: [
            { text: "The plugin system", link: "/guide/plugin-system" },
            { text: "Writing a plugin", link: "/guide/writing-plugins" },
            { text: "Plugin UI", link: "/guide/plugin-ui" },
            { text: "Skills", link: "/guide/skills" },
            { text: "Subagents", link: "/guide/subagents" },
            { text: "Tools & approvals", link: "/guide/tools" },
            { text: "Checkpoints & rollback", link: "/guide/checkpoints" },
            { text: "Models & providers", link: "/guide/models" },
            { text: "Protocol & API", link: "/guide/protocol" },
            { text: "Authentication & tenants", link: "/guide/authentication" },
            { text: "CLI", link: "/guide/cli" },
            { text: "Web console", link: "/guide/web-console" },
            { text: "Example plugins", link: "/guide/examples" },
          ],
        },
        {
          text: "Operating Kestrel",
          items: [
            { text: "Deployment", link: "/guide/deployment" },
            { text: "Security model", link: "/guide/security" },
            { text: "Roadmap", link: "/guide/roadmap" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Configuration", link: "/reference/config" },
            { text: "Kernel API", link: "/reference/kernel" },
            { text: "Agent API", link: "/reference/agent" },
            { text: "Plugin API", link: "/reference/plugins" },
            { text: "Wire protocol", link: "/reference/protocol" },
          ],
        },
      ],
      "/contributing": [
        {
          text: "Project",
          items: [
            { text: "Contributing", link: "/contributing" },
            { text: "Security", link: "/guide/security" },
            { text: "Roadmap", link: "/guide/roadmap" },
          ],
        },
      ],
    },
    search: {
      provider: "local",
      options: {
        detailedView: true,
      },
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Kestrel contributors",
    },
  },
});
