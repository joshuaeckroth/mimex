# Build Guide

This repo contains several Mimex targets:

- Web UI
- API server
- Electron desktop app
- Windows desktop installer
- CLI
- TUI
- MCP server

## Prerequisites

- Node.js 20.x
- `pnpm` via Corepack or a local install
- Run from repo root: `/home/josh/mimex`

Recommended setup:

```bash
corepack enable
pnpm install
```

## Build Everything

To run the workspace build graph:

```bash
pnpm build
```

This runs `turbo run build` across the repo.

## Web UI

Build:

```bash
pnpm --filter @mimex/web build
```

Output:

- `apps/web/dist/`

Run built Web UI locally:

```bash
pnpm --filter @mimex/web start
```

Run Web UI from source:

```bash
pnpm --filter @mimex/web dev
```

## API Server

Build:

```bash
pnpm --filter @mimex/api build
```

Output:

- `apps/api/dist/server.js`

Run built API:

```bash
pnpm --filter @mimex/api start
```

Run API in watch mode:

```bash
pnpm --filter @mimex/api dev
```

## Desktop App From Source

The Electron app depends on built API and Web artifacts.

Prepare runtime dependencies:

```bash
pnpm desktop:prepare
```

Run the desktop app:

```bash
pnpm desktop:dev
```

Or, after preparation:

```bash
pnpm desktop:start
```

What `desktop:prepare` builds:

- `packages/shared-types/dist/`
- `packages/core/dist/`
- `apps/api/dist/`
- `apps/web/dist/`

Desktop runtime staging created during packaging:

- `apps/desktop/runtime/`

## Windows Desktop Installer

Build the NSIS installer from native Windows PowerShell or `cmd`, not WSL:

```bash
pnpm desktop:nsis
```

Output:

- `apps/desktop/release/Mimex-Setup-<version>.exe`

Notes:

- This command first runs `desktop:prepare`.
- Packaging uses Electron Builder.
- If Windows executable editing causes privilege issues, the packaging script automatically retries with `signAndEditExecutable=false`.

## CLI

Build:

```bash
pnpm --filter @mimex/cli build
```

Output:

- `apps/cli/dist/index.js`

The built executable entrypoint is:

- `mimex-cli`

Run from source:

```bash
pnpm --filter @mimex/cli dev
```

## TUI

Build:

```bash
pnpm --filter @mimex/tui build
```

Output:

- `apps/tui/dist/index.js`

The built executable entrypoint is:

- `mimex`

Run from source:

```bash
pnpm --filter @mimex/tui dev
```

Windows launcher:

- `apps/tui/windows/mimex-tui.cmd`

The launcher builds `apps/tui/dist/index.js` automatically if it is missing.

## MCP Server

Build:

```bash
pnpm --filter @mimex/mcp build
```

Output:

- `apps/mcp/dist/server.js`

Run built MCP server:

```bash
pnpm --filter @mimex/mcp start
```

Run from source:

```bash
pnpm --filter @mimex/mcp dev
```

## Shared Packages

Build shared types:

```bash
pnpm --filter @mimex/shared-types build
```

Build core:

```bash
pnpm --filter @mimex/core build
```

Outputs:

- `packages/shared-types/dist/`
- `packages/core/dist/`

## Docker Builds

API image:

```bash
docker build -f apps/api/Dockerfile -t mimex-api .
```

Web image:

```bash
docker build -f apps/web/Dockerfile -t mimex-web .
```

## Cleaning Build Outputs

Clean the whole workspace:

```bash
pnpm clean
```

Or clean an individual package, for example:

```bash
pnpm --filter @mimex/web clean
```
