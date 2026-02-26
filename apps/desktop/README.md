# Mimex Desktop (Electron + Web UI)

This desktop app wraps the existing Mimex Web UI in an Electron window.

## How it works

- Starts `@mimex/api` from `apps/api/dist/server.js` on `127.0.0.1:8080`.
- Starts the web server from `apps/web/scripts/server.mjs` with `--root=dist` on `127.0.0.1:4173`.
- Opens a native window to `http://127.0.0.1:4173`.

## Run (dev)

From repo root:

```bash
pnpm install
pnpm desktop:dev
```

On Windows, you can also double-click:

- `apps/desktop/windows/mimex-desktop.cmd`

## Build NSIS installer (Windows)

From repo root:

```bash
pnpm install
pnpm desktop:nsis
```

Run this from native Windows PowerShell or `cmd` (not WSL).

Output:

- `apps/desktop/release/Mimex-Setup-<version>.exe`

## Optional environment variables

- `MIMEX_WORKSPACE_ROOT`
  - Dev default: `<repo>/data/workspaces`
  - Installed app default: `%APPDATA%/Mimex/workspaces`
- `MIMEX_DESKTOP_API_PORT` (default: `8080`)
- `MIMEX_DESKTOP_WEB_PORT` (default: `4173`)

## Notes

- This is a local desktop shell for the repo checkout.
- `desktop:prepare` builds all runtime artifacts used by both dev and installer flows.
- `dist:win` stages `apps/desktop/runtime` before packaging.
