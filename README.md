# @orkestia/composer

Build, check and publish [Orkestia](https://orkestia.dev) compositions.

A **composition** is a workflow made of other workflows: steps in layers, each
step's inputs mapped from the run's inputs, earlier results or fixed values,
with conditions, fan-outs, repeats and undo steps. `@orkestia/composer` gives
apps a way to let people build them without writing JSON.

- **`@orkestia/composer/model`**: the composition model, in pure TypeScript with
  no React and no DOM. It works in browsers, Node and workers.
- **`@orkestia/composer`**: the embeddable React editor: the list of
  compositions, each one as a step list or a diagram, with checks, runs and
  schedules. It talks only to a backend you pass in.

> **Status: pre-1.0.** The API is typed and tested but may still change between
> minors. See [CHANGELOG.md](CHANGELOG.md).

## Install

The package is not on npm yet. Install a release tarball from GitHub:

```bash
pnpm add https://github.com/orkestia/orkestia-composer/releases/download/v0.1.2/orkestia-composer-0.1.2.tgz
```

The tarball is built and attached by the release workflow for every `v*` tag, so
it already contains `dist/`. Pin the exact version you tested. `react` and
`react-dom` 19.2+ are peers.

## The editor

```tsx
import { CompositionEditor, liveCatalog, staticCatalog, type CompositionBackend } from '@orkestia/composer'
import '@xyflow/react/dist/style.css' // the diagram library's base styles
import '@orkestia/composer/style.css'

const backend: CompositionBackend = createMyBackend() // your platform calls (see below)
const catalog = liveCatalog(staticCatalog(myCatalogEntries))

export function Routines() {
  return <CompositionEditor backend={backend} catalog={catalog} locale="pt-BR" host={{ scopeKey: workspaceId }} />
}
```

The editor never calls a platform API itself. Everything goes through three seams:

- **`backend: CompositionBackend`**: list, read, check, save, run and schedule
  compositions. Optional members switch features off when absent: no `facts`
  means no schedule or run filters, no `inspect` means run results without
  per-step status, no `dependents` means no "who uses this" before saving.
  `capabilities: { publish: false }` opens everything read-only and hides Save,
  New and Run.
- **`catalog: LiveCatalog`**: the steps the person may use. Wrap a fixed list
  with `liveCatalog(staticCatalog(entries))`, or implement `LiveCatalog` to load
  schemas on demand.
- **`host: ComposerHost`**: dialogs, context menus, toasts, notifications,
  storage and the `scopeKey` that separates drafts per account or workspace.
  Each one is optional; the editor has an in-page default for all of them.

Slots: `renderAssistant` (a conversation that proposes a new definition with
`onPropose`; the person reviews and applies it), `renderToolbarTitle`,
`providerMarks` (logos you may show for step providers) and `icons` (replace any
icon).

**Styles.** `style.css` is scoped to `.oc-composer` and to the layer that menus,
dialogs and popovers render into, so it never restyles the host page. Theme it
by overriding `--ork-*` custom properties. Dark mode follows the system; force
it with `data-theme="dark"` or `data-theme="light"` on `<html>`, which covers
the overlays too.

**Languages.** `locale` is `en` (default), `pt-BR` or `es`. `messages` replaces
any string, keyed by its English text: `messages={{ 'New Workflow': 'New
routine' }}`.

One editor is mounted at a time per page: it keeps its state in a module-level
store that `CompositionEditor` binds to the backend you pass.

## Backends

Two backends ship with the package. Both take a client you already have: any
object with `run(type, input, timeoutMs?)` (run a workflow and resolve its
output), `start(type, input)` and `state(id)`, plus optional `get(path)` and
`post(path, body)` against the workflow API (`WorkflowsClientLike`). When a run
is refused, reject with an Error that carries the run's output on `data` (or
the code on `code`) so the backend can type the refusal.

```tsx
import { appBackend, memberBackend, CompositionEditor } from '@orkestia/composer'

// An organization member: every composition of the organization, the whole step registry.
const member = memberBackend(client, () => organizationId)

// An app's end user, signed in with Orkestia: their workspace's compositions,
// the app's authoring catalog, and schedules of at least 15 minutes.
const app = appBackend(endUserClient)

<CompositionEditor backend={app} host={{ scopeKey: `${appId}:${workspaceId}` }} />
```

`appBackend` finds the app's `composer-<key>-<app12>` entry points by name in
the organization's compositions (`GET /api/workflows/types?prefix=virtual.`,
page by page). If more than one app in the organization has authoring on, pass
`app12`: the first 12 hex characters of your identity app's uuid. Pass
`entryPoints` (key to `workflow_type`, as `identity.app.enable-authoring`
returns them) or `exposed` to skip discovery. Saving publishes: each attempt has one idempotency key, kept with
the draft, so trying again after a timeout never publishes twice; the editor
checks `publishStatus` before it offers Retry. When someone else published a
newer version, the editor warns first ("Save Anyway" saves over it). Without a
publish entry point, when the workspace's `capabilities` say so, or after
`CAPABILITY_REQUIRED`, the editor is read-only (and Run is hidden without
`run`). The step picker offers only the app's authorable steps.
Schedules go through the app's `composer-schedule-<verb>-<app12>` entry points
too; an app enabled before those existed gets them by running its authoring
enablement again.

Refusals reject with `ComposerError`: `error.code` is one of
`AUTHORING_NOT_ENABLED`, `CAPABILITY_REQUIRED`, `VERSION_CONFLICT`,
`STEP_NOT_AUTHORABLE`, `UNSCOPED_INPUT`, `NESTED_NOT_IN_WORKSPACE`,
`WORKSPACE_MISMATCH`, `QUOTA_EXCEEDED`, `RESERVED_NAME`, `WORKSPACE_REQUIRED`,
`NOT_FOUND`, `PUBLISH_IN_PROGRESS`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`,
`PUBLISH_ABANDONED`, `INTERNAL_ERROR`, `end_user_principal_required`,
`organization_mismatch` (or `TIMEOUT`,
`PUBLISH_PENDING`, `ENTRY_POINT_MISSING`, `SCHEDULE_TOO_FREQUENT`, `UNKNOWN`),
and `error.message` is translated.

**Schedules** run every N minutes, or by five cron fields read in an IANA time
zone (`0 9 * * 1-5` in `America/Sao_Paulo`). The editor shows the next five
planned runs, in the viewer's time zone and the schedule's. They are computed
in the client with the scheduler's rules (a local time that a DST change skips
doesn't run that day; a repeated one runs once), and the platform decides when
runs really start:

```ts
import { nextOccurrences, minGapSeconds } from '@orkestia/composer/model'

nextOccurrences('0 9 * * 1-5', new Date(), 5, 'America/Sao_Paulo') // Date[]
minGapSeconds('*/15 * * * *') // 900
```

## The model

A **recipe** is how a person describes a workflow: steps read top to bottom,
data passed as chips, and a few wrapping blocks (Only if, For each, Repeat).
Layers, input mappings and step names belong to the compiler, never to the
person.

```ts
import { compile, decompile, check, staticCatalog, type CatalogEntry } from '@orkestia/composer/model'

// What the model knows about each workflow type: title, inputs, outputs.
// Hosts usually build this from the platform's workflow catalog.
const catalog = staticCatalog([
  {
    type: 'control.value.format', title: 'Format text', app: 'Control', readOnly: true,
    inputs: [{ name: 'template', type: 'string', required: true }],
    outputs: [{ name: 'result', type: 'string' }],
  } satisfies CatalogEntry,
])

// Open any saved definition as an editable recipe…
const recipe = decompile(savedDefinition, catalog)
if (recipe.readOnly.length) console.log('Opened read-only:', recipe.readOnly)

// …find problems, in plain words, pinned to the step they belong to…
for (const problem of check(recipe, catalog)) console.log(problem.severity, problem.message)

// …and compile it back to the definition `composition.save` accepts.
const { definition, problems } = compile(recipe, catalog)
```

What `compile` guarantees:

- **Ordering.** A step runs after every step whose data it uses, or whose
  result its "Only if" reads. Actions keep the order they were written in.
  Lookups run as early as their data allows. Layers are the longest-path levels
  of that graph.
- **Stable output.** Compiling an unchanged recipe gives the same bytes.
- **Round-trip.** Decompiling and compiling a definition keeps its steps,
  wiring, inputs, metadata and version. The compiler owns layer names and
  grouping. A definition that uses settings the editor does not edit opens
  read-only, with the reason, instead of losing them.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm dev        # the editor on an in-memory backend (harness/)
```

The full-library round-trip test runs when `COMPOSER_LIBRARY_DIR` points at a
folder of `<name>/definition.json` compositions.

## License

[MIT](LICENSE)
