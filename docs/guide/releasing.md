# Releasing Kestrel

A Kestrel release is three artifacts produced from one immutable tag: the source tree on GitHub,
a multi-architecture container image in GitHub Container Registry, and a static build of this
documentation site. Nothing is published until the same commit has passed the full verification
pipeline that protects `main`.

## Versioning

Kestrel follows [semantic versioning](https://semver.org). The product version appears in exactly
one place in source — `packages/protocol/src/version.ts` — and is mirrored into every workspace
`package.json` by a script, so the binary, the API and the published image can never disagree.

| Record | Source of truth | Checked by |
| --- | --- | --- |
| `KESTREL_VERSION` | `packages/protocol/src/version.ts` | `pnpm version:check` |
| Every `package.json` | root `package.json` | `pnpm version:check` |
| `GET /api/health` `version` | `KESTREL_VERSION` | `pnpm smoke` |
| Image tag | git tag `v<version>` | release workflow |

`PROTOCOL_VERSION` (`1.0`) is independent: it changes only when the wire format breaks. A patch
release must never require a console or plugin rebuild.

Before `1.0`, a minor release may contain breaking plugin API changes. Those are called out in the
changelog under **Changed**, and the previous minor line keeps receiving fixes.

## Release checklist

1. **Decide the version.** Patch for fixes, minor for features, major for a breaking plugin or
   protocol contract.

2. **Write the changelog.** Add entries under `## [Unreleased]` using the Keep a Changelog
   headings. The release workflow extracts exactly the section for the new version as the GitHub
   release body and refuses to publish an empty or placeholder section.

3. **Cut the release.** One command does the rest — it refuses to run on a dirty tree, a tag that
   already exists, or an empty unreleased section:

   ```bash
   pnpm release:prepare 0.2.0 --dry-run   # print the bump and the section roll
   pnpm release:prepare 0.2.0
   ```

   It rolls `## [Unreleased]` into `## [0.2.0] - <date>`, leaves a fresh unreleased section,
   rewrites every manifest and `KESTREL_VERSION`, verifies `pnpm version:check` and the changelog
   extraction, commits `chore(release): 0.2.0`, and creates the annotated tag `v0.2.0`. Pass
   `--sign` to make it a GPG/SSH-signed tag when a key is configured.

4. **Push the commit and the tag together.** This is the only step that needs a credential, and
   it is deliberately the only one:

   ```bash
   git push --follow-tags origin main
   ```

Everything after that push is automatic. The workflow derives the image name from the repository
(`ghcr.io/<owner>/<repo>`), takes its registry credential from `GITHUB_TOKEN`, and signs the image
with GitHub's OIDC identity, so there is nothing to configure and no repository secret to rotate.

5. **Watch the release workflow**, then verify the published image (see below).

## What CI enforces

Every push to `main` and every pull request runs these gates on Node 22 and Node 24:

| Gate | Command | Catches |
| --- | --- | --- |
| Version contract | `pnpm version:check` | drift between source, manifests and the reported version |
| Types | `pnpm typecheck` | cross-package API breakage |
| Lint | `pnpm lint` | unused code, suspicious patterns |
| Tests | `pnpm test` | unit, HTTP and SSE behaviour, including every error path |
| Build | `pnpm build` | bundling failures for server, CLI, plugins and console |
| Artifact smoke | `pnpm smoke` | a bundle that compiles but cannot boot, serve the console or stream SSE |
| Docs | `pnpm docs:build` | broken links and MDX errors |

The container job builds the image and then *runs* it: it waits for `/api/health`, checks that the
reported version matches the repository, asserts that at least one plugin loaded, and verifies the
process does not run as root. A Dockerfile change that breaks startup fails CI, not the release.

### The smoke test

`scripts/smoke.mjs` starts `apps/server/dist/bin.js` against a throwaway workspace with hot reload
enabled and asserts the release-facing surface:

- `GET /api/health` reports the repository version, protocol `1.0` and a non-zero plugin count.
- Anonymous requests to `/api/sessions` are rejected with `401`.
- `GET /api/bootstrap` returns models, tools and plugins.
- The declared example plugin is discovered and active.
- `GET /` serves the console and its compiled bundle with a CSP header.
- Unknown API routes return the documented `not_found` envelope.
- `GET /api/plugins/events` emits a `ready` frame with plugin revisions.

Run it locally after any build-tooling change:

```bash
pnpm build
pnpm smoke
```

## The release workflow

`.github/workflows/release.yml` triggers on tags matching `v*` and runs three jobs.

1. **verify** — refuses to continue unless the tag equals `package.json`'s version, then repeats
   the whole CI suite, extracts the changelog section, and packages the documentation site with a
   SHA-256 checksum.
2. **image** — builds `linux/amd64` and `linux/arm64` with BuildKit provenance and an SBOM, pushes
   to `ghcr.io/<owner>/<repo>` with these tags, and signs the digest with cosign keyless signing
   (GitHub OIDC, no long-lived key):

   | Tag | Example | Meaning |
   | --- | --- | --- |
   | `{{version}}` | `0.2.0` | immutable release |
   | `{{major}}.{{minor}}` | `0.2` | latest patch of the line |
   | `latest` | `latest` | latest stable release |
   | `sha-<short>` | `sha-1a2b3c4` | commit traceability |

3. **publish** — creates the GitHub release from the changelog section and attaches the
   documentation tarball and `checksums.txt`.

The workflow needs no repository secrets beyond the automatically provided `GITHUB_TOKEN`; the
image job requests `packages: write` and `id-token: write` only.

## Verifying a published release

```bash
# Signature (keyless: identity is the workflow that built the image)
cosign verify ghcr.io/OWNER/REPO:0.2.0 \
  --certificate-identity-regexp '^https://github.com/OWNER/REPO/.github/workflows/release.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# The running artifact agrees with the tag
docker run --rm -p 7331:7331 -e KESTREL_TOKEN=check ghcr.io/OWNER/REPO:0.2.0 &
curl -s http://127.0.0.1:7331/api/health
```

`version` in that response must equal the tag without the leading `v`. If the image and the tag
disagree, the release is broken even if every job reported success.

For the documentation bundle:

```bash
sha256sum -c checksums.txt
```

## Rolling back

The image tags are immutable apart from `latest`, so a rollback is a redeploy of the previous
patch version — no rebuild. Database and workspace state are forward-compatible within a minor
line: SQLite sessions written by `0.2.x` remain readable by earlier `0.2.y` because migrations are
additive. If a rollback crosses a minor boundary, back up the data directory first.

Never re-point an existing tag at a new commit. Publish a new patch release instead: consumers pin
tags and verify signatures, and both guarantees assume tags do not move.

## Documentation site

`pnpm docs:build` produces `docs/.vitepress/dist`. CI uploads it as the `documentation` artifact,
and every release attaches a checksummed tarball.

`.github/workflows/docs.yml` publishes that build to GitHub Pages on every push to `main` that
touches `docs/`. The site is served from a project subdirectory, so the build takes its prefix from
`DOCS_BASE` (`/kestrel/` in the workflow, `/` by default). Pointing a custom domain at the site only
requires changing that variable and the repository's Pages settings; the release contract does not
change, and any other host (Netlify, S3, or the Kestrel server itself) can serve the same artifact.
