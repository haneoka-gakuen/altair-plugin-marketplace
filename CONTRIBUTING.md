# Contributing

Use Node.js 20 or newer and pnpm 11. Run `pnpm check` before opening a change.
Keep the service metadata-only, deterministic, non-mutating, bounded, and
cancellation-safe. Add tests for hostile catalogs, dependency resolution,
permissions, locks, and service lifecycle changes.

Never evaluate catalog text or dynamically import a catalog source. Do not add
package execution, credentials, game assets, or duplicated Altair marketplace
logic.

Maintainers publish from GitHub releases through npm trusted publishing. The
npm package must authorize this repository's `.github/workflows/publish.yml`
workflow before the first release.
