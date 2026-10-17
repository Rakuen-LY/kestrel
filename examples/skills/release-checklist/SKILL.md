---
name: release-checklist
description: Cut a versioned release without breaking the changelog or the version files.
when-to-use: The user asks to ship, tag, publish or bump a version.
---

# Release checklist

1. Confirm the working tree is clean (`git status --short`).
2. Bump the version in `package.json` and any package manifests that mirror it.
3. Run the full gate: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
4. Add a dated entry to `CHANGELOG.md` under a new heading. Group entries by
   Added, Changed, Fixed and Removed.
5. Commit with `chore(release): vX.Y.Z`.
6. Tag the commit (`git tag -a vX.Y.Z -m "vX.Y.Z"`) and push both the branch and the tag.
7. Publish the container image and record the digest in the release notes.

Never skip step 3 to save time. A release that fails its own tests costs more than the
minutes it saves.
