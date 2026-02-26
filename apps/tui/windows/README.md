# Mimex TUI Windows Launcher

`mimex-tui.cmd` is a double-click launcher for Windows.

## What it does

- Resolves repo root from the launcher location.
- Ensures `node` and `pnpm` are available.
- Builds `@mimex/tui` if `apps/tui/dist/index.js` is missing.
- Opens a dedicated `cmd` window and runs the TUI.

## Usage

1. Open this folder in Explorer.
2. Double-click `mimex-tui.cmd`.

Optional:

- Set `MIMEX_WORKSPACE_PATH` before launch if you want a non-default workspace.
