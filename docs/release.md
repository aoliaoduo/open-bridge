# Release process

Git tags, `CHANGELOG.md` and GitHub Releases are one release contract. Do not
edit GitHub Release titles or bodies by hand: `scripts/release-notes.mjs` is the
canonical renderer and `scripts/release-publish.mjs` is the canonical publisher.

## Normal release

1. Move the finished entries from `[Unreleased]` into `## [X.Y.Z] — YYYY-MM-DD`.
2. Update `package.json` and `package-lock.json` to `X.Y.Z`.
3. Run `npm run release:check`.
4. Run `npm run release:audit -- --local`.
5. Commit the release, create annotated tag `vX.Y.Z`, then push `main` and the tag.
6. Optionally preview with `npm run release:publish -- --dry-run vX.Y.Z`.
7. Run `npm run release:publish -- vX.Y.Z` from a clean working tree.
8. Run `npm run release:audit`.

`release:publish` derives the title, body, prerelease bit and latest bit from the
tag and CHANGELOG, and refuses a dirty working tree so unpublished local notes
cannot leak into a tagged release. Stable titles are always `Open Bridge vX.Y.Z`; prerelease
titles use the same rule. The highest stable semantic-version tag is the only
Release marked Latest.

## Repair or normalize release history

`npm run release:publish -- --all` rewrites or creates every semver Release that
has a local Git tag, using the matching CHANGELOG section. It never creates Git
tags. Follow it with `npm run release:audit`.

The audit fails on version drift, missing tag/Release pairs, title drift,
prerelease/latest mistakes, Release bodies that differ from generated CHANGELOG
notes, or tracked references to the retired repository URL.

## npm

GitHub Release publication and `npm publish` are separate operations. Do not run
`npm publish` unless the release explicitly includes npm registry publication.
