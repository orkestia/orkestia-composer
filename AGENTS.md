# AGENTS.md: @orkestia/composer

A public, MIT-licensed TypeScript package. It provides the composition model (`src/model`) and the React editor
(`src/ui`). pnpm, Vite library build, vitest. `pnpm dev` runs the editor on an in-memory backend (`harness/`).

## Commands
Run from the repo root.
- `typecheck`: `pnpm run typecheck`
- `test`: `pnpm test`. One file: `pnpm exec vitest run src/model/compile.test.ts`
- `build`: `pnpm run build`

CI (`.github/workflows/ci.yml`) runs those three. All three must pass on the final head.

## Rules
- **`src/model` stays pure.** No React, no DOM and no Node imports. It type-checks against `lib: ES2023` only. The
  one host global it uses is declared in `src/model/globals.d.ts`. Tests may use `node:fs` for fixtures.
- **Tests sit next to the code** as `*.test.ts(x)`. Every new behaviour gets one. Fixtures live in
  `src/model/__fixtures__`.
- **The round-trip must not lose anything.** Decompile → compile keeps a definition's steps, wiring, inputs,
  metadata and version (see `golden.test.ts`). A setting the editor cannot edit opens the recipe read-only, with a
  reason. It is never dropped silently.
- **The editor never calls a platform.** Everything goes through `CompositionBackend`, `LiveCatalog` and
  `ComposerHost` (`src/ui/host.ts`). A host-specific need becomes an optional member or a slot, never an import.
- **Every user-facing string goes through `t()`** (or `plural()`, or `msg()` for labels in tables, translated where
  shown) with the English text as the key, and gets `pt-BR` and `es` entries in `src/ui/i18n/`. `i18n.test.ts`
  fails when a key is missing or stale.
- **Styling:** `src/ui/styles.css` only, scoped to `:where(.oc-composer, .oc-composer-layer)`, colours as `--ork-*`
  custom properties defined once in its token block. No hex colour literals anywhere else. Anything rendered into
  `<body>` (portals) goes inside a `.oc-composer-layer` element.
- **UI tests** start with `// @vitest-environment jsdom` and use the in-memory backend in `src/ui/fixtures.ts`
  (not exported).
- **This repository is public.** Never add internal URLs or hostnames, organization or account ids, customer names,
  tokens, secrets, or references to private repositories or packages, in code, fixtures, tests or docs. Use
  placeholder ids such as `00000000000000000000000000000001`. Where a host client type is needed, define a minimal
  local interface rather than importing a private SDK.
- Keep the diff small and on topic. Commit subjects are short and imperative (`feat(model): …`).
- Update `CHANGELOG.md` under `[Unreleased]` for anything a consumer would notice.
