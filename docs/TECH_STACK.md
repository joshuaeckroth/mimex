# Mimex Tech Stack (Slim)

## Product Surface

- Local-first note system backed by plain files and git history.
- One note title with multiple markdown bodies.
- Hard-link parsing with search fallback.
- Soft-link graph built from actual traversal events.
- Multiple interfaces over shared core logic: API, CLI, TUI, MCP, Web.

## Chosen Stack

## Core + Backend

- Language/runtime: TypeScript on Node.js.
- Monorepo: `pnpm` + `turbo`.
- Shared domain layer: `packages/core`.
- Shared contracts: `packages/shared-types`.
- HTTP API: Fastify (`apps/api`).
- MCP integration: official MCP TypeScript SDK over stdio (`apps/mcp`).
- Persistence: filesystem + git in per-user workspaces.
- Local caching: metadata cache files under `~/.cache/mimex` (or `$XDG_CACHE_HOME/mimex`).

## Clients

- CLI: `commander` + TypeScript (`apps/cli`).
- TUI: `neo-blessed` + TypeScript (`apps/tui`).
- Web: static HTML/CSS/JS (`apps/web`) with minimal Node static/proxy server.

## Data Model and Storage

- Workspace root per user: `data/workspaces/<userId>/`.
- Notes:
  - `notes/<noteId>/note.json`
  - `notes/<noteId>/bodies/<bodyId>.md`
- Soft-link store:
  - `.mimex/softlinks.json`
- Git repo exists inside each workspace and is auto-committed on writes.

## Deployment Strategy (Slim Cloud)

Constraint: single TLS host (`mimex.dev`) and low monthly overhead.

- One EC2 host (`t4g.small` default) running Docker Compose.
- Caddy as reverse proxy + TLS termination.
- Routes:
  - `/` -> web container
  - `/api/*` -> api container
- Workspace files mounted on host volume into API container.
- ECR repositories for web and api images.
- Route53 root `A` record to EC2 Elastic IP.

## MCP in Deployment

- Current MCP server is stdio-based (`apps/mcp`), not HTTP-exposed in cloud routing.
- If remote MCP access is needed later, add an explicit HTTP bridge service and route.

## Why This Stack

- Keeps behavior consistent by centralizing logic in `packages/core`.
- Avoids operational drag from extra stateful services.
- Maintains low-cost deployment with simple failure domains.
- Supports fast iteration on UX/performance without schema migrations.

## Repository Layout

- `apps/api`
- `apps/cli`
- `apps/mcp`
- `apps/tui`
- `apps/web`
- `packages/core`
- `packages/shared-types`
- `infra/terraform`
- `scripts/aws`
