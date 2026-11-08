# Changelog

All notable changes to `@orkestia/composer` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/). Before 1.0, a new minor can change
the API: pin a caret range on the minor you tested (`^0.1.0`).

## [Unreleased]

## [0.1.2] - 2026-11-08

### Fixed
- `appBackend` found no entry points against the live platform. It read the
  first 500 rows of the types list, which are library types; the app's
  `composer-*` compositions are only reached with the `virtual.` prefix. It now
  asks for `prefix=virtual.` and follows `has_more` page by page.
- The types list shows the entry points of every app in the organization. The
  editor now uses the one app that offers the full authoring set, refuses with
  `ENTRY_POINT_MISSING` (detail: pass `app12`) when several do, and compares
  versions of an entry point only within one app (the newest wins).

## [0.1.1] - 2026-11-08

### Fixed
- `appBackend` schedules now go through the app's `composer-schedule-<verb>-<app12>`
  entry points (`list`, `runs`, `create`, `update`, `pause`, `resume`, `delete`).
  An end-user token may start only exposed compositions, so calling
  `schedule.app.*` by name was refused with `NOT_EXPOSED_TO_END_USERS`. An app
  gets the entry points by running its authoring enablement again; until then
  the verbs are still called by name.

## [0.1.0] - 2026-11-08

### Added
- `@orkestia/composer`: the embeddable React editor, `CompositionEditor`.
  - The composition list (search, filters, sort) and each composition as a step
    list or a diagram, sharing one recipe and one undo history.
  - Step picker, data chips, Only if / For each / Repeat blocks, undo steps,
    checks with one-click fixes, run order, saved JSON, runs and schedules.
  - `CompositionBackend` / `ScheduleBackend`: every read and write goes through
    a backend the host passes in. Optional members switch features off.
    `capabilities.publish: false` makes the editor read-only.
  - `ComposerHost`: confirm, menu, toast, notify, storage and `scopeKey`, each
    with an in-page default.
  - Slots: `renderAssistant` (propose, review, apply), `renderToolbarTitle`,
    `providerMarks` and `icons`.
  - `style.css`, scoped to the editor, themed with `--ork-*` custom properties,
    with light and dark defaults.
  - Locales `en`, `pt-BR` and `es`, plus per-string overrides through `messages`.
- `@orkestia/composer/model`: the composition model in pure TypeScript.
  - Recipes: steps read top to bottom, data passed as chips, and Only if /
    For each / Repeat blocks.
  - `compile()` turns a recipe into the authoring dialect `composition.save`
    accepts, with deterministic layering.
  - `decompile()` reads any saved definition back. A definition with settings
    the editor does not edit opens read-only, with the reason.
  - `check()` explains problems in plain words, pinned to the step.
  - Editing operations (`addStep`, `connect`, `moveInto`, …), undo history, the
    diagram graph, list filters, and inference of undeclared run inputs.
- The definition's own `version` label is kept through decompile → compile.
- A golden round-trip test over example compositions in the library format.
- Backends (`@orkestia/composer`), over a host-provided `WorkflowsClientLike`
  (`run`, `start`, `state`, optional `get` / `post`):
  - `memberBackend(client, org)`: an organization member's compositions,
    checks, saves, activation, archiving, dependents, runs, run inspector,
    history, field options and schedules, with the platform registry as the
    step catalog (`backend.catalog()`, labels through `options.labels`).
  - `appBackend(client, options)`: an app end user's workspace, through the
    `composer-<key>-<app12>` entry points found by name in the app's exposed
    list, and `schedule.app.*`. Save publishes idempotently (one key per
    attempt, kept with the draft); a timeout is checked with `publishStatus`
    before offering Retry; `VERSION_CONFLICT` opens "Someone else changed this
    workflow". Runs come from the schedules plus the runs started in the editor
    (remembered locally, labelled "started here"). No step-by-step run view.
    Read-only (and Run hidden) as the workspace's `capabilities` say, when the
    app offers no publish entry point, or after `CAPABILITY_REQUIRED`. Test run
    asks for the dry run. Only authorable steps are offered. Every wire field
    name lives in one adapter module, matching the `composition.app.*`
    contract. A live workflow the workspace is not offered (the list's
    `availability: unexposed`) shows "not available to run" and hides Run
    until it is published again.
  - `ComposerError` with a stable `code` for every refusal
    (`AUTHORING_NOT_ENABLED`, `CAPABILITY_REQUIRED`, `VERSION_CONFLICT`, …,
    `PUBLISH_ABANDONED`, `organization_mismatch`), read from `failure_details`
    and the `"<CODE>: "` message, and
    a message in `en`, `pt-BR` and `es`.
  - `publishWithRecovery`, `newIdempotencyKey`, `PlatformCatalog`.
- Schedules by time expression: five cron fields in an IANA time zone, beside
  "every N minutes". The editor shows the next five planned runs in the
  viewer's time zone and the schedule's, and holds app schedules to 15 minutes.
  The pure functions (`nextOccurrences`, `minGapSeconds`, `plannedRuns`,
  `cadenceProblem`, …) are in `@orkestia/composer/model`; `PlannedRuns` and
  `CadenceFields` are exported for hosts with their own schedule screens.

### Changed
- `ScheduleBackend.create` takes a number of minutes or a `Cadence`;
  `update` takes `schedule_expression` / `timezone`. `Schedule` carries them.
- `CompositionBackend.save` takes `SaveOptions` (`title`, `expectedVersion`)
  and may return the lineage `name` the backend stored it under. New optional
  members: `publish`, `publishStatus`, `publishRecovery`, `activate`,
  `archive`, `catalog`. `CompositionRow.title`, `RunRow.source`.
- `CompositionEditor` uses `backend.catalog()` when no `catalog` is passed.
- A recipe's `runs` may carry `cron` and `timezone`.
