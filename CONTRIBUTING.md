# Contributing to Alchemist Coder

Thanks for helping! This is the open-source core (AGPL-3.0) of Alchemist Coder.

## Before your first pull request

1. **Sign the CLA.** A bot comments on your first PR with a link; reply with the sentence it asks for. The [CLA](CLA.md) lets us ship your contribution in both the Community and Pro editions.
2. Open an issue first for anything bigger than a small fix, so we can agree on the approach.

## Development

You need Node.js 22.13 or later (CI uses 24) and pnpm 8.15.9; `corepack enable` picks the right pnpm from `package.json`.

```bash
pnpm install
pnpm dev                  # desktop app with hot reload
pnpm test                 # vitest, every package
pnpm test packages/themes # only one folder or file
pnpm typecheck
pnpm index:smoke          # index your real history into a throwaway database and print stats
```

Tests live in `packages/*/test` and `apps/desktop/test`.

- The indexer must stay **read-only** on `~/.claude` and `~/.codex`. Never write to those folders.
- Transcript formats are undocumented and change between CLI versions. Parsers must tolerate unknown fields and records; add a fixture test for every new record shape you handle.
- Keep secrets out of logs, telemetry and the index. Credentials belong in the OS keychain.

## Dependencies

Core dependencies must use **permissive licenses** (MIT, BSD, Apache-2.0, ISC). GPL-only dependencies would prevent shipping the core inside the Pro edition, so CI rejects them.

## Commits and pull requests

- Small, focused PRs with a clear description of *why*.
- Tests for behaviour changes; `pnpm test` and `pnpm typecheck` must pass.
- User-facing strings go through the i18n dictionaries, in all 11 languages: `apps/desktop/src/renderer/src/locales/` for the app and `apps/desktop/src/main/locales/` for menus, automations and notifications. `apps/desktop/test/locales.test.ts` fails if a language misses a key or changes its `{variables}`. A rough translation is fine; native speakers polish it.
- A count takes its singular and other forms as `<key>.one` (and `.few`/`.many` in Russian), following each language's plural rules. Japanese, Korean and Chinese have none. See `apps/desktop/src/renderer/src/i18n.ts`.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
