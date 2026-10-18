# Contributing

The contributor guide lives in the documentation site:

- [Contributing](docs/contributing.md) — setup, conventions, tests, pull request checklist.

Quick version:

```bash
corepack enable
pnpm install
pnpm version:check && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm smoke && pnpm docs:build
```

Use focused commits with imperative subjects. Add tests for behaviour changes and update the
documentation in the same pull request. Report security issues privately as described in
[docs/guide/security.md](docs/guide/security.md#reporting-a-vulnerability).

By contributing, you agree that your contribution is licensed under the MIT licence.
