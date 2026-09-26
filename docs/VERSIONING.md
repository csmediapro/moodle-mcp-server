# Versioning and Release Rules

The canonical Moodle MCP Server package is `moodle-mcp-server-aql` in
`packages/server/package.json`.

This repository uses lockstep versioning for all workspace package metadata,
including private workspace packages, to avoid confusing release state. A
release version is not considered complete unless all of these match:

- `package.json`
- `packages/server/package.json`
- `packages/client/package.json`
- `package-lock.json` workspace entries
- `server.json`
- `server.json` npm package entry
- `CHANGELOG.md`
- git tag `vX.Y.Z`
- npm package `moodle-mcp-server-aql@X.Y.Z`
- GitHub Release `vX.Y.Z`

Run this before tagging or publishing:

```bash
npm run version:check
```

## Release Checklist

1. Decide the next semver version.
2. Update every versioned file.
3. Add a `CHANGELOG.md` entry.
4. Run:

```bash
npm install --package-lock-only --ignore-scripts
npm run version:check
npm run server:test
```

5. Commit the release changes.
6. Tag the exact commit as `vX.Y.Z`.
7. Publish `packages/server` to npm as `moodle-mcp-server-aql@X.Y.Z`.
8. Create the GitHub Release for `vX.Y.Z`.

Publishing, deprecating npm versions, and creating GitHub Releases are public
external actions. Do them only after explicit approval.

## Current Reconciliation Notes

As of the current reconciliation pass, npm, git tags, `packages/server`, and
`server.json` recognize `0.1.4` as the latest published package version.
GitHub Releases are stale and need backfilled or corrected separately.

Because npm already has `0.1.4`, the next normal published fix should be
`0.1.5` unless a deliberate deprecation/backfill plan says otherwise.
