# Mimex MCP Server

`@mimex/mcp` exposes action-oriented tools over MCP stdio for working with Mimex notes.

## Scope

- The server exposes note/link/workspace actions only.
- It does **not** accept a directory path for ingestion.
- Directory traversal, file parsing, and note planning should be done by an external tool/agent, which then calls Mimex MCP tools to persist results.

## Run

```bash
pnpm --filter @mimex/mcp dev
```

or:

```bash
pnpm --filter @mimex/mcp build
node apps/mcp/dist/server.js
```

## Codex MCP config (copy/paste)

Build once:

```bash
pnpm --filter @mimex/mcp build
```

Then add this server entry to your Codex MCP config:

```json
{
  "mcpServers": {
    "mimex": {
      "command": "node",
      "args": ["/home/josh/mimex/apps/mcp/dist/server.js"],
      "env": {
        "MIMEX_WORKSPACE_ROOT": "/home/josh/mimex/data/workspaces",
        "MIMEX_DEFAULT_USER_ID": "local",
        "MIMEX_AUTO_COMMIT": "true"
      }
    }
  }
}
```

Alternative:

```json
{
  "mcpServers": {
    "mimex": {
      "command": "pnpm",
      "args": ["--filter", "@mimex/mcp", "start"],
      "cwd": "/home/josh/mimex"
    }
  }
}
```

## Environment

- `MIMEX_WORKSPACE_ROOT` (default: `./data/workspaces`)
- `MIMEX_DEFAULT_USER_ID` (default: `local`)
- `MIMEX_AUTO_COMMIT` (default: `true`)

Each tool accepts optional `userId` to select an isolated workspace under `MIMEX_WORKSPACE_ROOT`.

## Tools

- `mimex_workspace_info`
- `mimex_note_list`
- `mimex_note_titles`
- `mimex_note_get`
- `mimex_note_create`
- `mimex_body_add`
- `mimex_body_update`
- `mimex_note_archive`
- `mimex_note_restore`
- `mimex_search_notes`
- `mimex_links_hard`
- `mimex_follow_link`
- `mimex_links_soft`

Notes:

- `mimex_note_list` supports paging via `offset` and `limit`.
- `mimex_note_titles` is the lightweight option for large title listings.
- `mimex_search_notes` supports `limit` up to `200`.

## External ingestion pattern

1. External tool scans/parses a directory.
2. External tool decides note titles/aliases/body markdown.
3. External tool calls:
   - `mimex_note_create` for a new note (or existing note by title)
   - `mimex_body_add` for additional bodies
4. Optional post-processing:
   - `mimex_links_hard` and `mimex_follow_link`
   - `mimex_search_notes` for validation
