# Mimex Tech Stack Decisions

## Product Surface

- Local-first notes knowledge base with Git-backed storage and automatic commits
- One note title can have multiple distinct markdown bodies
- Hard links in markdown with unresolved-link search fallback
- Soft-link graph based on actual user traversal, with weighted ranking
- MCP protocol server, Web UI, TUI, and CLI
- Multi-user with private workspaces

## Chosen Stack

### Core + Backend

- Language/runtime: TypeScript on Node.js 24 LTS
- Monorepo tooling: `pnpm` + `turbo`
- Core domain package: `packages/core`
- Local daemon/API: Fastify (`apps/api`)
- MCP server: official MCP TypeScript SDK (`apps/mcp`)
- Git integration: system `git` CLI invoked from core/api
- Search/index: SQLite + FTS5 for local indexing and unresolved-link lookup

### Clients

- Web UI: React + Vite + TypeScript (`apps/web`)
- Terminal UI: Ink + TypeScript (`apps/tui`)
- CLI: `commander` + TypeScript (`apps/cli`)

## Deployment Strategy (low-cost)

Constraint honored: single TLS host `mimex.dev` (no subdomains).

- One EC2 host (`t4g.small` default) with Docker Compose
- Reverse proxy container (Caddy) handles TLS and path routing
- Routes:
  - `/` -> web
  - `/api/*` -> backend API
  - `/mcp/*` -> MCP service
- Database: local Postgres container on the same host
- Storage: local encrypted EBS volume (instance root volume)
- Registry: ECR for web and API images
- DNS: Route53 root `A` record for `mimex.dev`

## Why this strategy now

- Removes fixed ALB + NAT costs and keeps monthly baseline low
- Keeps app/API/MCP behavior unchanged under one root domain
- Simple operations footprint while traffic is still early-stage

## Repository Layout (recommended)

- `apps/web`
- `apps/api`
- `apps/mcp`
- `apps/cli`
- `apps/tui`
- `packages/core`
- `infra/terraform`
- `scripts/aws`

## Operational Notes

- User workspaces are private by design, isolated by authenticated user id.
- Auto-merge strategy keeps conflict markers in markdown text for deferred resolution.
- Soft-link counters are event-based and append-only, making sync and merge resilient.
