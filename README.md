# Skills-Manager

[中文](./README.zh-CN.md)

> Package: `@dsh-skills-manager/dsh-skills-manager`
> A dual-face Skills management plugin for DeepSeek Harness (DSH).

Skills-Manager unifies Agent Skills discovered from many sources behind one
management surface. It is a [Cordis](https://cordis.js.org/) plugin split into
two independently built and loaded halves:

- **Host half (Node.js)** — scans, imports, and manages skills from multiple
  sources; owns the skill registry, trash bin, repository browsing, company
  skill sources, and update/diff tooling. Registers a `ctx.skills` provider so
  every enabled skill becomes live for the harness.
- **Client half (browser)** — renders a unified Skills panel inside the DSH
  settings area, with five tabs: Skills, Trash, Repositories, Company, Updates.

The two halves talk over **webServer HTTP** (`/api/skills-manager`): the client
calls typed routes with `fetch` and re-pulls a snapshot after every mutation.

> Full architecture, data model, and design rationale live in
> [DESIGN.md](./DESIGN.md).

## Features

- **Multi-source discovery** — DSH global, project, per-agent (Codex / Claude /
  Copilot), and extra user directories.
- **Import & authoring** — import from a zip archive, a folder, or a single
  `SKILL.md`; or create a brand-new managed skill.
- **Enable / disable** — toggle skills live against the harness catalog.
- **Trash with retention** — soft delete, restore, permanent purge, empty, and
  automatic expiry cleanup (default 30 days).
- **Repository sources** — browse GitHub repositories, list their skills, and
  install them.
- **Company sources** — register `api` / `git` enterprise endpoints, sync, and
  install advertised skills.
- **Updates & diff** — check upstream versions and review an inline unified diff
  before applying an update.
- **Local persistence** — JSON documents under `~/.dsh/skills-manager/` with
  revision tracking and file watching.

## Architecture

```
Host half (Node.js)                         Client half (browser)
  src/index.ts                                src/client/index.ts
  SkillsManager service  ◄── HTTP fetch ──►   Settings panel (React)
  JsonFileStore (~/.dsh/skills-manager/)      re-pull snapshot after each change
  tsc → lib/index.js                          tsdown → client/client.js
```

- **Transport** — one `prefix` route `/api/skills-manager` registered on
  `ctx.webServer`; every response is a `{ ok, data }` / `{ ok, code, error }`
  JSON envelope.
- **Security** — requests must originate from a loopback host (or a
  `same-origin` / `none` `sec-fetch-site`); every mutating `POST` must carry the
  `x-dsh-skills-manager` marker header and an `application/json` content type;
  request bodies are capped at 4 MB.

## Quick Start

### Prerequisites

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0` (declared as `packageManager`)

### Install & build

```bash
pnpm install
pnpm build       # clean → tsc (host) → tsdown (client) → normalize banner
```

`pnpm build` produces the host bundle under `lib/` and the browser bundle at
`client/client.js`.

### Verify

```bash
pnpm typecheck   # host + client + test projects, --noEmit
pnpm test        # node:test runner over test/**/*.test.ts
```

### Load into DSH

This package is a DSH bundle plugin. It declares:

- `dsh.bundle.patch` → `./cordis.patch.yml` (inserts the plugin into the profile
  layer stack as `id: skills-manager`),
- `dsh.client.inject` → `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-locale`,
- `dsh.client.platform` → `web`.

Once the package is installed into a DSH host that consumes these fields, the
host half registers the `/api/skills-manager` route and the `ctx.skills`
provider on load, and the client half contributes the panel to the
`settings.section` slot. Open the harness **Settings → Skills Manager** to use
it.

### Development watch

```bash
pnpm watch       # tsdown --watch for the client half
pnpm test:watch  # re-run tests on change
```

## Configuration

The host plugin reads the following config (all optional; zero-config defaults
resolve to a local setup):

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `projectRoot` | `string` | `''` | Project root scanned as the `project` source. |
| `extraDirs` | `string[]` | `[]` | Extra directories scanned as the `local` source. |
| `agentRoots.codex` | `string` | `''` | Override for the Codex skills directory. |
| `agentRoots.claude` | `string` | `''` | Override for the Claude skills directory. |
| `agentRoots.copilot` | `string` | `''` | Override for the Copilot skills directory. |
| `githubApiBase` | `string` | `https://api.github.com` | GitHub REST API base. |
| `githubRawBase` | `string` | `https://raw.githubusercontent.com` | GitHub raw content base. |
| `githubToken` | `string` | `''` | Optional bearer token for authenticated requests. |
| `trashRetentionDays` | `number` | `30` | Days a trashed skill is kept before auto-purge. |
| `scanOnStart` | `boolean` | `true` | Whether to run a discovery scan at startup. |

## Scripts

| Script | Purpose |
| --- | --- |
| `build` | `clean` → `tsc -p tsconfig.json` → `tsdown` → `normalize-client-banner` |
| `build:client` | Bundle the client half only |
| `typecheck` | `--noEmit` check across host, client, and test tsconfigs |
| `test` | `node --test "test/**/*.test.ts"` |
| `test:watch` | `test` in watch mode |
| `bundle` / `watch` | `tsdown` bundle / watch |
| `clean` | Run `scripts/clean.mjs` |
| `prepack` | `build` + `scripts/preflight.mjs` guard |

## Project Structure

```
src/
  index.ts        Host plugin entry (config schema, inject, apply)
  service.ts      SkillsManager orchestration core
  http.ts         Host↔Client HTTP transport (/api/skills-manager)
  file-store.ts   JSON persistence (revision tracking + file watching)
  scanner.ts      Multi-source discovery
  importer.ts     zip / folder / file import + create
  diff.ts         LCS unified diff
  github.ts       GitHub repo & company source remotes
  skill-file.ts   SKILL.md parsing / serialization / id hashing
  types.ts        Shared wire vocabulary + Cordis event augmentation
  client/         Browser half (panel, api client, wire types, locales, styles)
test/             node:test suites (http + api)
DESIGN.md         Full design document
```

## Tech Stack

- **Language** — TypeScript
- **Frontend** — React 18 (`React.createElement`, no JSX runtime), lightningcss
  for CSS Modules
- **Runtime deps** — `jszip`, `yaml`
- **Build** — `tsc` (host) + `tsdown` (client)
- **Tests** — Node built-in `node:test` with native TypeScript type stripping

## License

MIT
