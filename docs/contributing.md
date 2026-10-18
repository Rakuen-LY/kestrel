# Contributing

Thanks for taking the time to improve Kestrel. The project values small, well-argued changes over
large speculative ones.

## Before you start

- Read [Architecture](/guide/architecture) and [The plugin system](/guide/plugin-system).
- Search issues and discussions; someone may already be working on it.
- For a new capability, open an issue that describes the use case before writing code.
- For security issues, follow [Security](/guide/security#reporting-a-vulnerability) instead of
  opening a public issue.

## Development setup

```bash
git clone <your-fork> kestrel
cd kestrel
corepack enable
pnpm install
pnpm build
pnpm test
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Server with `tsx` watch on `:7331`. |
| `pnpm dev:web` | Vite dev server on `:5173`, proxying `/api`. |
| `pnpm build` | Build every package in dependency order. |
| `pnpm typecheck` | `tsc --noEmit` across packages. |
| `pnpm lint` | `oxlint` over packages, apps and plugins. |
| `pnpm test` | Vitest, once. |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm version:check` | Assert the version is identical in source, manifests and workspace packages. |
| `pnpm smoke` | Boot the built server and assert the release-facing HTTP surface. Run after `pnpm build`. |
| `pnpm docs:dev` | Documentation site with hot reload. |

## Repository layout

```
packages/kernel        services, contexts, scopes, plugins
packages/protocol      shared wire types
packages/agent         sessions, registries, run loop, stores
packages/plugin-host   discovery, manifests, dependency ordering
apps/server            HTTP + SSE adapter and composition root
apps/cli               terminal client
apps/web               browser console
plugins/*              first-party extensions
examples/plugins/*     minimal, annotated examples
deploy/*               Docker, Compose, Kubernetes, systemd, launchd, Windows
docs/                  VitePress site
```

## Conventions

- **TypeScript, ESM, Node 22.** Relative imports use the `.js` extension, as required by Node's ESM
  resolver.
- **No new runtime dependencies in the kernel.** It must stay embeddable and auditable.
- **Services are explicit.** New capability means a new service or tool, not a global.
- **Every registration is disposable.** If you add a listener, timer or child process, return a
  disposer from the surrounding `effect` or `inject`.
- **Errors carry context.** Say which path, plugin or field failed, and what to do next.
- **No comments that restate code.** Comment invariants, workarounds and trade-offs.
- **Formatting** follows `.editorconfig` (2 spaces, LF, final newline). `pnpm lint` is the source of
  truth for lint rules.

## Tests

- Place unit tests next to the code as `*.test.ts`, or under `test/` for package-level suites.
- Prefer real objects over mocks. The kernel is pure; the runtime can use `@kestrel/testkit`'s
  `ScriptedModel` instead of a real provider.
- A bug fix should come with a test that fails before the fix.
- Server tests should assert status codes, headers and event frames, not just bodies.

```bash
pnpm vitest run packages/kernel
pnpm vitest run apps/server
```

## Adding a plugin to the repository

1. Create `plugins/<name>/` with `package.json` and `kestrel.plugin.json`.
2. Name it `@kestrel/plugin-<name>`.
3. Declare `inject` for services and `requires` only for real plugin ordering.
4. Add a short README covering configuration and the tools or services it contributes.
5. Add tests for the non-trivial branches.
6. Register it in `README.md` and, if user-facing, in the documentation.

The worked example in [Writing a plugin](/guide/writing-plugins) is the template.

## Documentation

- Docs are in `docs/` and built with VitePress.
- Every page starts with a single H1; headings are sentence case.
- Code fences need a language. Prefer runnable examples over fragments.
- When documenting an API, read the source first. Incorrect reference docs are worse than none.
- Run `pnpm docs:build` before opening a pull request; dead links fail the build.

## Commit and pull request

- Keep commits focused and imperative: `server: reject empty messages`, not `fixes`.
- Describe the behaviour change and how you verified it.
- Link the issue when there is one.
- Update tests and documentation in the same pull request.
- Do not include generated `dist/`, `.kestrel/` or editor files.

## Review

A change is ready when:

- the build, typecheck, lint, tests and artifact smoke test pass locally;
- new behaviour is documented;
- failure modes are handled and visible;
- a reviewer can understand the diff without reading this file.

Maintainers may ask for a smaller scope. That is normal: the project optimises for a foundation
that survives the next few years, not for throughput of merged pull requests.

## Licence

By contributing, you agree that your contribution is licensed under the MIT licence.
